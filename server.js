/*Environment variables to add (to App Settings in the Web Job in Azure, or as env variables if using another service): 
Twitter (@https://dev.twitter.com):
CONSUMER_KEY
CONSUMER_SECRET
ACCESS_TOKEN_KEY
ACCESS_TOKEN_SECRET

Cognitive Services (@https://www.microsoft.com/cognitive-services/en-us/text-analytics-api):
SUBSCRIPTION_KEY

Azure IotHub (@https://azure.microsoft.com/en-us/free):
CONNECTION_STRING

Azure Storage (@https://azure.microsoft.com/en-us/free):
AZURE_STORAGE_CONNECTION_STRING

Topic:
TWEETS_TOPIC
*/

var twitter = require('twitter');
var request = require('request');
var iothub = require('azure-iothub');
var azure = require('azure-storage');
var lastColor = "";

var hubClient = iothub.Client.fromConnectionString(process.env.CONNECTION_STRING);
var redObj = { s:0, r: 255, g: 0, b: 0 };
var red = JSON.stringify(redObj);
var blueObj = { s: 0, r: 0, g: 0, b: 255 };
var blue = JSON.stringify(blueObj);
var greenObj = { s: 0, r: 0, g: 255, b: 0 };
var green = JSON.stringify(greenObj);

var client = new twitter({
    consumer_key: process.env.CONSUMER_KEY,
    consumer_secret: process.env.CONSUMER_SECRET,
    access_token_key: process.env.ACCESS_TOKEN_KEY,
    access_token_secret: process.env.ACCESS_TOKEN_SECRET
});

var tweetsTopic = process.env.TWEETS_TOPIC; 
var tweetsLanguage = "en"; //"es", "en", "fr", "pt"
var tweetsText = '';
var sentiment = 0.5;
var stream;

function handleTweet(event) {
    var retweeted = event.retweeted_status;
    var tweet = (retweeted == null ? event.text : event.retweeted_status.text);
    tweetsText += " " + tweet; //avoid reaching API calls trial limitation per second for trending topics, send several tweets to analyze in one json
};

function search() {
    var myJSON = { "documents": [] };
    stream = client.stream('statuses/filter', { track: tweetsTopic, language: tweetsLanguage });

    stream.on('data', handleTweet);

    stream.on('error', function (error) {
        console.log('Twitter error on stream: ' + error);
    });

    analyzeTweets();
}

var analyzeLoop;

function analyzeTweets() {
    try {
        if (tweetsText.length > 0) {
            analyzeText(tweetsText);
            tweetsText = '';
        }
    } catch (err) {
        console.log('Error on AnalyzeTweets: ' + err);
    }

    analyzeLoop = setTimeout(analyzeTweets, 1000);
}

function analyzeText(tweet) {
    var score = 0;
    var myJSON = { "documents": [{ id: 1, text: tweet }] };
    var options = {
        url: 'https://westus.api.cognitive.microsoft.com/text/analytics/v2.0/sentiment',
        headers: {
            'Content-Type': 'application/json',
            'Ocp-Apim-Subscription-Key': process.env.SUBSCRIPTION_KEY,
            'Accept': 'application/json'
        },

        method: "POST",
        body: JSON.stringify(myJSON)
    };
    var result = request(options, function (error, response, body) {
        if (!error && response.statusCode == 200) {
            var color = '';
            var colorName = '';
            var info = JSON.parse(body);
            score = info.documents[0].score;
            sentiment = (sentiment + score) / 2;
            if (sentiment > 0.6) {
                color = green;
                colorName = 'green'
            }
            else if (sentiment < 0.4) {
                color = red;
                colorName = 'red';
            }
            else {
                color = blue;
                colorName = 'blue';
            }

            if (color != lastColor) {
                console.log(colorName + ' (' + sentiment + ') - tweet:' + tweet);
                lastColor = color;
            }

            hubClient.send('MyRaspi', color, function (err) {
                if (err) {
                    console.log('IoTHub error on send: ' + err);
                }
            });            
        }
        else
            console.log('Cognitive services error on request: ' + response.statusCode);
    });
}

function listenQueue() {
    var queueSvc = azure.createQueueService();

    function listen() {
        queueSvc.getMessages('mynotwiqueue', function (error, result, response) {
            if (!error) {
                if (result.length > 0) {
                    // Message text is in messages[0].messageText 
                    var message = result[0];
                    console.log('Topic changed: ' + message.messageText);

                    clearTimeout(analyzeLoop);
                    stream.removeListener('data', handleTweet);
                    stream.destroy();

                    sentiment = 0.5; //reset sentiment, start new topic in blue
                    tweetsTopic = message.messageText;
                    search();

                    queueSvc.deleteMessage('mynotwiqueue', message.messageId, message.popReceipt, function (error, response) {
                        if (!error) {
                            //message deleted 
                        }
                        else {
                            console.log('Azure storage queue error on deleteMessage: ' + error);
                        }
                    });
                }
            }
            else {
                console.log('Azure storage queue error on getMessage: ' + error)
            }
        });
    }
    setInterval(listen, 1000);
}

function cleanText(text) {
    //remove or modify mentions, URLs, to send normalized text to the text analytics analysis. Not needed for now
    var urlLess_text = text.replace(/(?:https?|ftp):\/\/[\n\S]+/g, '');
    var mentionLess_text = urlLess_text.replace(/\B@[a-z0-9_-]+/gi, '');

    return mentionLess_text;
}

listenQueue();

hubClient.open(search);