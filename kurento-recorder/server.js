/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

var path = require('path');
var url = require('url');
var cookieParser = require('cookie-parser')
var express = require('express');
var session = require('express-session')
var minimist = require('minimist');
var ws = require('ws');
var kurento = require('kurento-client');
var fs    = require('fs');
var https = require('https');

var argv = minimist(process.argv.slice(2), {
    default: {
        as_uri: 'https://localhost:8443/',
        ws_uri: 'ws://localhost:8888/kurento',
        file_uri: 'file:///tmp/recorder_demo.webm', // file to be stored in media server
    }
});

var options =
{
  key:  fs.readFileSync('keys/server.key'),
  cert: fs.readFileSync('keys/server.crt')
};

var app = express();

/*
 * Management of sessions
 */
app.use(cookieParser());

var sessionHandler = session({
    secret : 'none',
    rolling : true,
    resave : true,
    saveUninitialized : true
});

app.use(sessionHandler);

/*
 * Definition of global variables.
 */
var sessions = {};
var candidatesQueue = {};
var kurentoClient = null;

/*
 * Server startup
 */
var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function() {
    console.log('Kurento Tutorial started');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
    server : server,
    path : '/helloworld'
});

/*
 * Management of WebSocket messages
 */
wss.on('connection', function(ws) {
    var sessionId = null;
    var request = ws.upgradeReq;
    var response = {
        writeHead : {}
    };

    sessionHandler(request, response, function(err) {
        sessionId = request.session.id;
        console.log('Connection received with sessionId ' + sessionId);
    });

    ws.on('error', function(error) {
        console.log('Connection ' + sessionId + ' error');
        stop(sessionId);
    });

    ws.on('close', function() {
        console.log('Connection ' + sessionId + ' closed');
        stop(sessionId);
    });

    ws.on('message', function(_message) {
        var message = JSON.parse(_message);
        console.log('Connection ' + sessionId + ' received message ', message);

        switch (message.id) {
        case 'start':
            sessionId = request.session.id;
            start(sessionId, ws, message.sdpOffer, function(error, sdpAnswer) {
                if (error) {
                    return ws.send(JSON.stringify({
                        id : 'error',
                        message : error
                    }));
                }
                ws.send(JSON.stringify({
                    id : 'startResponse',
                    sdpAnswer : sdpAnswer
                }));
            });
            break;

        case 'play':
            sessionId = request.session.id;
            play(sessionId, ws, message.sdpOffer, function(error, sdpAnswer) {
                if (error) {
                    return ws.send(JSON.stringify({
                        id : 'error',
                        message : error
                    }));
                }
                ws.send(JSON.stringify({
                    id : 'playResponse',
                    sdpAnswer : sdpAnswer
                }));
            });
            break;

        case 'stop':
            stop(sessionId);
            break;

        case 'onIceCandidate':
            onIceCandidate(sessionId, message.candidate);
            break;

        default:
            ws.send(JSON.stringify({
                id : 'error',
                message : 'Invalid message ' + message
            }));
            break;
        }

    });
});

/*
 * Definition of functions
 */

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }

    kurento(argv.ws_uri, function(error, _kurentoClient) {
        if (error) {
            console.log("Could not find media server at address " + argv.ws_uri);
            return callback("Could not find media server at address" + argv.ws_uri
                    + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

function start(sessionId, ws, sdpOffer, callback) {
    if (!sessionId) {
        return callback('Cannot use undefined sessionId');
    }

    getKurentoClient(function(error, kurentoClient) {
        if (error) {
            return callback(error);
        }

        kurentoClient.create('MediaPipeline', function(error, pipeline) {
            if (error) {
                return callback(error);
            }

            var elements =
            [
              {type: 'RecorderEndpoint', params: {uri : argv.file_uri}},
              {type: 'WebRtcEndpoint', params: {}}
            ];

            createMediaElements(elements, pipeline, function(error, elements) {

                var recorder = elements[0];
                var webRtc   = elements[1];

                if (error) {
                    pipeline.release();
                    return callback(error);
                }

                if (candidatesQueue[sessionId]) {
                    while(candidatesQueue[sessionId].length) {
                        var candidate = candidatesQueue[sessionId].shift();
                        webRtc.addIceCandidate(candidate);
                    }
                }
                
                connectMediaElementsWithRecorder(kurentoClient, webRtc, webRtc, recorder, function(error) {
                    if (error) {
                        pipeline.release();
                        return callback(error);
                    }

                    webRtc.on('OnIceCandidate', function(event) {
                        var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                        ws.send(JSON.stringify({
                            id : 'iceCandidate',
                            candidate : candidate
                        }));
                    });

                    webRtc.processOffer(sdpOffer, function(error, sdpAnswer) {
                        if (error) {
                            pipeline.release();
                            return callback(error);
                        }

                        sessions[sessionId] = {
                            'pipeline' : pipeline,
                            'webRtcEndpoint' : webRtc,
                            'recorder' : recorder
                        }
                        return callback(null, sdpAnswer);
                    });

                    webRtc.gatherCandidates(function(error) {
                        if (error) {
                            return callback(error);
                        }
                    });

                    recorder.record(function(error) {
                        if (error) return onError(error);
                        console.log("record");
                    });

                });
            });
        });
    });
}

function play(sessionId, ws, sdpOffer, callback) {
    if (!sessionId) {
        return callback('Cannot use undefined sessionId');
    }

    getKurentoClient(function(error, kurentoClient) {
        if (error) {
            return callback(error);
        }

        kurentoClient.create('MediaPipeline', function(error, pipeline) {
            if (error) {
                return callback(error);
            }

            var options = {uri : argv.file_uri}
            createMediaElementsWithOption('PlayerEndpoint', options, pipeline, function(error, player) {
                
                if (error) return onError(error);


                player.on('EndOfStream', function(event){
                    console.log('END OF STREAM');
                    pipeline.release();
                });

                    
                player.play(function(error) {
                    if (error) return onError(error);
                    console.log("Playing ...");

                    createMediaElements('WebRtcEndpoint', pipeline, function(error, webRtcEndpoint) {
                        if (error) {
                            pipeline.release();
                            return callback(error);
                        }

                        webRtcEndpoint.on('OnIceCandidate', function(event) {
                            var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                            console.log('OnIceCandidate called');
                            ws.send(JSON.stringify({
                                id : 'iceCandidate',
                                candidate : candidate
                            }));
                        });

                        if (candidatesQueue[sessionId]) {
                            console.log('candidatesQueue');
                            while(candidatesQueue[sessionId].length) {
                                var candidate = candidatesQueue[sessionId].shift();
                                webRtcEndpoint.addIceCandidate(candidate);
                            }
                        }

                        webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
                            console.log('processOffer');
                            if (error) {
                                pipeline.release();
                                return callback(error);
                            }

                            sessions[sessionId] = {
                                'pipeline' : pipeline,
                                'webRtcEndpoint' : webRtcEndpoint,
                            }

                            connectMediaElements(player, webRtcEndpoint,function(error) {
                                if (error) return onError(error);

                                console.log('connectMediaElements');
                                return callback(null, sdpAnswer);
                            });                                  
                        });

                        webRtcEndpoint.gatherCandidates(function(error) {
                            if (error) {
                                return callback(error);
                            }
                        });
                    });
                });
            });
        });
    });
}

function createMediaElements(elements, pipeline, callback) {
    pipeline.create(elements, function(error, elements) {
        if (error) {
            return callback(error);
        }

        return callback(null, elements);
    });
}

function createMediaElementsWithOption(elements, option, pipeline, callback) {
    pipeline.create(elements, option,function(error, elements) {
        if (error) {
            return callback(error);
        }

        return callback(null, elements);
    });
}

function connectMediaElements(target_1, target2, callback) {
    target_1.connect(target2, function(error) {
        if (error) {
            return callback(error);
        }
        return callback(null);
    });
}

function connectMediaElementsWithRecorder(client, webRtc1, webRtc2, recorder, callback) {
    client.connect(webRtc1, webRtc2, recorder, function(error) {
        if (error) {
            return callback(error);
        }
        return callback(null);
    });
}

function stop(sessionId) {
    if (sessions[sessionId]) {
        var pipeline = sessions[sessionId].pipeline;
        var webRtcEndpoint = sessions[sessionId].webRtcEndpoint;
        var recorder = sessions[sessionId].recorder;

        console.info('Releasing pipeline');

        delete sessions[sessionId];
        delete candidatesQueue[sessionId];

        if(recorder)
            recorder.stop();
        pipeline.release();

    }
}

function onIceCandidate(sessionId, _candidate) {
    var candidate = kurento.getComplexType('IceCandidate')(_candidate);

    if (sessions[sessionId]) {
        console.info('Sending candidate');
        var webRtcEndpoint = sessions[sessionId].webRtcEndpoint;
        webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        console.info('Queueing candidate');
        if (!candidatesQueue[sessionId]) {
            candidatesQueue[sessionId] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}

app.use(express.static(path.join(__dirname, 'static')));

