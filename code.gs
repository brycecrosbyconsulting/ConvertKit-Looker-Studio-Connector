Working Script - v1

// Global variables
var cc = DataStudioApp.createCommunityConnector();
var BASE_URL = 'https://api.convertkit.com/v3';

function getAuthType() {
  Logger.log('Setting authentication method to NONE');
  return cc.newAuthTypeResponse()
    .setAuthType(cc.AuthType.NONE)
    .build();
}

function getConfig(request) {
  Logger.log('Getting connector configuration');
  var config = cc.getConfig();
  
  config.newTextInput()
    .setId('apiSecret')
    .setName('API Secret')
    .setHelpText('Enter your ConvertKit API secret key.')
    .setAllowOverride(true);

  config.setDateRangeRequired(true);
  
  return config.build();
}

function isAdminUser() {
  return true;
}

function getSchema(request) {
  Logger.log('Constructing schema based on request');
  var fields = cc.getFields();
  var types = cc.FieldType;

  fields.newDimension()
    .setId('date')
    .setName('Date')
    .setType(types.YEAR_MONTH_DAY);

  fields.newMetric()
    .setId('new_subscribers')
    .setName('New Subscribers')
    .setType(types.NUMBER);

  fields.newMetric()
    .setId('cancelled_subscribers')
    .setName('Cancelled Subscribers')
    .setType(types.NUMBER);

  fields.setDefaultMetric('new_subscribers');
  fields.setDefaultDimension('date');

  Logger.log('Schema constructed');
  return { schema: fields.build() };
}

function getData(request) {
  Logger.log('Received data request:', JSON.stringify(request));
  try {
    var apiSecret = request.configParams.apiSecret;
    var startDate = request.dateRange.startDate;
    var endDate = request.dateRange.endDate;
    Logger.log(`Fetching data for dates: ${startDate} to ${endDate}`);

    var requestedFields = request.fields.map(field => field.name);
    Logger.log('Complete request object:', JSON.stringify(request, null, 2));
    Logger.log('Requested fields:', requestedFields.join(', '));

    var fetchedData = fetchAllData(apiSecret, startDate, endDate, requestedFields);
    Logger.log('Data fetched successfully');

    var aggregatedData = aggregateData(fetchedData, requestedFields);
    Logger.log('Data aggregated successfully');

    // Make sure rows are constructed with values in the order of the requested fields
    var rows = constructRows(aggregatedData, request.fields);
    Logger.log('Rows constructed successfully');

    var schema = constructSchema(requestedFields);
    Logger.log('Schema constructed successfully based on requested fields');

    var response = {
      schema: schema,
      rows: rows,
      filtersApplied: false
    };

    Logger.log('Final data being returned to Looker Studio:', JSON.stringify(response, null, 2));
    return response;
  } catch (error) {
    Logger.log('Error fetching data from ConvertKit API:', error);
    cc.newUserError()
      .setDebugText('Error fetching data from ConvertKit API: ' + error)
      .setText('There was an error retrieving data from the connector. Please try again.')
      .throwException();
  }
}




function fetchAllData(apiSecret, startDate, endDate, requestedFields) {
  var fetchedData = {
    newSubscribers: [],
    cancelledSubscribers: []
  };

  if (requestedFields.includes('new_subscribers')) {
    var totalPagesNew = getTotalPages(apiSecret, startDate, endDate, 'subscribed');
    fetchedData.newSubscribers = fetchSubscribersInParallel(apiSecret, startDate, endDate, totalPagesNew, 'subscribed');
  }

  if (requestedFields.includes('cancelled_subscribers')) {
    var totalPagesCancelled = getTotalPages(apiSecret, startDate, endDate, 'cancelled', false);
    fetchedData.cancelledSubscribers = fetchSubscribersInParallel(apiSecret, startDate, endDate, totalPagesCancelled, 'cancelled');
  }

  return fetchedData;
}

function aggregateData(fetchedData, requestedFields) {
  var aggregatedData = {};

  requestedFields.forEach(field => {
    if (field === 'new_subscribers' || field === 'cancelled_subscribers') {
      var key = field === 'new_subscribers' ? 'newSubscribers' : 'cancelledSubscribers';
      aggregatedData[field] = fetchedData[key].reduce((acc, subscriber) => {
        var formattedDate = formatDateString(subscriber.created_at, 'yyyyMMdd');
        acc[formattedDate] = (acc[formattedDate] || 0) + 1;
        return acc;
      }, {});
    }
  });

  return aggregatedData;
}

function constructRows(aggregatedData, fieldObjects) {
  var rows = [];
  var allDates = new Set([...Object.keys(aggregatedData['new_subscribers'] || {}), ...Object.keys(aggregatedData['cancelled_subscribers'] || {})]);

  allDates.forEach(date => {
    // Initialize row values starting with the date
    var rowValues = [];
    
    // Add field values in the order they were requested
    fieldObjects.forEach(fieldObj => {
      var fieldName = fieldObj.name;
      if (fieldName === 'date') {
        rowValues.push(date);
      } else if (aggregatedData[fieldName]) {
        rowValues.push(aggregatedData[fieldName][date] || 0);
      }
    });

    rows.push({ values: rowValues });
  });

  return rows;
}


function constructSchema(requestedFields) {
  var schema = requestedFields.map(field => {
    switch (field) {
      case 'date':
        return { name: 'date', dataType: 'STRING' };
      case 'new_subscribers':
        return { name: 'new_subscribers', dataType: 'NUMBER' };
      case 'cancelled_subscribers':
        return { name: 'cancelled_subscribers', dataType: 'NUMBER' };
      default:
        return null;
    }
  }).filter(field => field != null);

  return schema;
}

function getTotalPages(apiSecret, startDate, endDate, state, includeState = true) {
  var url = `${BASE_URL}/subscribers?api_secret=${apiSecret}&from=${startDate}&to=${endDate}`;
  if (includeState) {
    url += `&state=${state}`;
  }
  var sortField = state === 'cancelled' ? 'cancelled_at' : 'created_at';
  url += `&sort_field=${sortField}`;

  var response = UrlFetchApp.fetch(url);
  var parsedResponse = JSON.parse(response.getContentText());
  return parsedResponse.total_pages || 1;
}

function fetchSubscribersInParallel(apiSecret, startDate, endDate, totalPages, state) {
    var allSubscribers = [];
    var backoffTime = 1000; // Start with a 1 second backoff time.
    var maxBackoffTime = 32000; // Set a maximum backoff time to prevent infinite waiting.
    
    for (let currentPage = 1; currentPage <= totalPages; currentPage++) {
        var sortField = state === 'cancelled' ? 'cancelled_at' : 'created_at';
        let url = `${BASE_URL}/subscribers?api_secret=${apiSecret}&from=${startDate}&to=${endDate}&page=${currentPage}&sort_field=${sortField}`;
        // Only include state parameter for subscribed state to fetch new subscribers
        if (state !== 'cancelled') {
            url += `&state=subscribed`;
        }

        while (true) {
            try {
                let response = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
                if (response.getResponseCode() == 200) {
                    let parsedResponse = JSON.parse(response.getContentText());
                    allSubscribers = allSubscribers.concat(parsedResponse.subscribers.map(sub => ({ created_at: sub.created_at })));
                    Logger.log(`Successfully fetched page ${currentPage} after waiting ${backoffTime}ms.`);
                    backoffTime = 1000; // Reset backoff time after a successful request
                    break; // Break out of the retry loop on success
                } else if (response.getResponseCode() == 429) {
                    Logger.log(`Rate limit exceeded, retrying page ${currentPage} after ${backoffTime}ms.`);
                    Utilities.sleep(backoffTime);
                    backoffTime *= 2; // Exponential backoff
                    if (backoffTime > maxBackoffTime) backoffTime = maxBackoffTime; // Cap the backoff time
                } else {
                    // Handle other HTTP errors (e.g., 400, 500) if necessary
                    Logger.log(`Failed to fetch page ${currentPage}: ${response.getContentText()}`);
                    break; // Break on other types of errors
                }
            } catch (e) {
                Logger.log(`Exception fetching page ${currentPage}: ${e}`);
                break; // Break on exceptions
            }
        }
    }

    return allSubscribers;
}

function formatDateString(isoString, format) {
  var date = new Date(isoString);
  return Utilities.formatDate(date, "UTC", format);
}

function testConnector() {
  var request = {
    dateRange: {
      startDate: '2024-01-31',
      endDate: '2024-01-31',
    },
    fields: [
      { name: 'date' },
      { name: 'new_subscribers' },
      { name: 'cancelled_subscribers' }
    ],
    configParams: {
      apiSecret: 'enter API Secret'
    }
  };
  var response = getData(request);
  Logger.log(JSON.stringify(response));
}
