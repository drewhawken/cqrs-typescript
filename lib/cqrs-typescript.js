var __extends = this.__extends || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    __.prototype = b.prototype;
    d.prototype = new __();
};
/// <reference path="node.d.ts"/>
/// <reference path="node_redis.d.ts"/>
/// <reference path="async.d.ts"/>
var Redis = require('redis');
var Async = require('async');

var HandlerRegistry = (function () {
    function HandlerRegistry() {
        this.commandsRegistry = {};
        this.eventsRegistry = {};
    }
    HandlerRegistry.prototype.registerCommandHandler = function (commandName, commandHandler) {
        var handlers = this.commandsRegistry[commandName];
        if (!handlers) {
            handlers = [];
        }

        handlers.push(commandHandler);
        this.commandsRegistry[commandName] = handlers;
    };

    HandlerRegistry.prototype.registerEventHandler = function (eventName, eventHandler) {
        var handlers = this.eventsRegistry[eventName];
        if (!handlers) {
            handlers = [];
        }

        handlers.push(eventHandler);
        this.eventsRegistry[eventName] = handlers;
    };

    HandlerRegistry.prototype.handleCommand = function (commandToHandle, callback) {
        var handlers = this.commandsRegistry[commandToHandle.body.name];
        if (!handlers)
            return callback(null);

        Async.forEach(handlers, function (handler, callback) {
            handler.handleCommand(commandToHandle, callback);
        }, callback);
    };

    HandlerRegistry.prototype.handleEvent = function (eventToHandle, callback) {
        var handlers = this.eventsRegistry[eventToHandle.body.name];
        if (!handlers)
            return callback(null);

        Async.forEach(handlers, function (handler, callback) {
            handler.handleEvent(eventToHandle, callback);
        }, callback);
    };
    return HandlerRegistry;
})();
exports.HandlerRegistry = HandlerRegistry;

var EventSourced = (function () {
    function EventSourced(id) {
        this.id = id;
        this.events = new Array();
        this.version = 0;
    }
    EventSourced.prototype.getId = function () {
        return this.id;
    };

    EventSourced.prototype.getVersion = function () {
        return this.version;
    };

    EventSourced.prototype.getEvents = function () {
        return this.events;
    };

    EventSourced.prototype.loadFromEvents = function (events) {
        var self = this;
        events.forEach(function (item) {
            self["on" + item.name](item);
            self.version = item.version;
        });
    };

    EventSourced.prototype.update = function (versionedEvent) {
        versionedEvent.sourceId = this.id;
        versionedEvent.version = this.version + 1;
        this["on" + versionedEvent.name](versionedEvent);
        this.version = versionedEvent.version;
        this.events.push(versionedEvent);
    };
    return EventSourced;
})();
exports.EventSourced = EventSourced;

var RedisResource = (function () {
    function RedisResource(options) {
        this.options = options;
    }
    RedisResource.prototype.getClient = function () {
        return this.client;
    };

    RedisResource.prototype.connect = function (callback) {
        this.client = Redis.createClient(this.options.port, this.options.host);

        this.client.on('error', function (errorMessage) {
            if (errorMessage.indexOf && errorMessage.indexOf('connect') >= 0) {
                callback(errorMessage);
            }
        });

        var self = this;
        this.client.on('ready', function () {
            if (self['onConnected']) {
                self['onConnected']();
            }

            callback(null);
        });
    };
    return RedisResource;
})();
exports.RedisResource = RedisResource;

var RedisCommandReceiver = (function (_super) {
    __extends(RedisCommandReceiver, _super);
    function RedisCommandReceiver(options, commandReceiver) {
        _super.call(this, options);
        this.commandReceiver = commandReceiver;
    }
    RedisCommandReceiver.prototype.onConnected = function () {
        var self = this;
        var receiveLoop = function () {
            if (self.paused)
                return setTimeout(receiveLoop, 500);

            self.getClient().rpoplpush('messaging.queuedcommands', 'messaging.activecommands', function (error, result) {
                if (result) {
                    var command = JSON.parse(result);
                    return self.commandReceiver.handleCommand(command, function (error) {
                        self.getClient().lrem('messaging.activecommands', 0, result, function (error, count) {
                            if (count !== 1)
                                throw "invalid count " + count;
                            receiveLoop();
                        });
                    });
                }

                setTimeout(receiveLoop, 500);
            });
        };

        receiveLoop();
    };
    return RedisCommandReceiver;
})(RedisResource);
exports.RedisCommandReceiver = RedisCommandReceiver;

var RedisEventReceiver = (function (_super) {
    __extends(RedisEventReceiver, _super);
    function RedisEventReceiver(options, eventReceiver) {
        _super.call(this, options);
        this.eventReceiver = eventReceiver;
    }
    RedisEventReceiver.prototype.onConnected = function () {
        var self = this;
        var receiveLoop = function () {
            if (self.paused)
                return setTimeout(receiveLoop, 500);

            self.getClient().rpoplpush('messaging.queuedevents', 'messaging.activeevents', function (error, result) {
                if (result) {
                    var _event = JSON.parse(result);
                    return self.eventReceiver.handleEvent(_event, function (error) {
                        self.getClient().lrem('messaging.activeevents', 0, result, function (error, count) {
                            if (count !== 1)
                                throw 'invalid "messaging.activeevents" count ' + count;
                            receiveLoop();
                        });
                    });
                }

                setTimeout(receiveLoop, 500);
            });
        };

        receiveLoop();
    };
    return RedisEventReceiver;
})(RedisResource);
exports.RedisEventReceiver = RedisEventReceiver;

var RedisCommandBus = (function (_super) {
    __extends(RedisCommandBus, _super);
    function RedisCommandBus(options) {
        _super.call(this, options);
    }
    RedisCommandBus.prototype.handleCommand = function (commandToHandle, callback) {
        var commandSerialized = JSON.stringify(commandToHandle);
        this.getClient().rpush('messaging.queuedcommands', commandSerialized, callback);
    };
    return RedisCommandBus;
})(RedisResource);
exports.RedisCommandBus = RedisCommandBus;

var RedisEventBus = (function (_super) {
    __extends(RedisEventBus, _super);
    function RedisEventBus(options) {
        _super.call(this, options);
    }
    RedisEventBus.prototype.handleEvent = function (eventToHandle, callback) {
        var eventSerialized = JSON.stringify(eventToHandle);
        this.getClient().rpush('messaging.queuedevents', eventSerialized, callback);
    };
    return RedisEventBus;
})(RedisResource);
exports.RedisEventBus = RedisEventBus;

var InMemoryEventSourcedRepository = (function () {
    function InMemoryEventSourcedRepository() {
        this.db = {};
    }
    InMemoryEventSourcedRepository.prototype.getEventsByAggregateId = function (id, callback) {
        if (!this.db[id])
            return callback(null, []);

        var aggregateEvents = this.db[id];
        callback(null, aggregateEvents);
    };

    InMemoryEventSourcedRepository.prototype.saveEventsByAggregateId = function (id, events, callback) {
        var aggregateEvents = this.db[id];
        if (!aggregateEvents)
            aggregateEvents = [];
        aggregateEvents = aggregateEvents.concat(events);
        this.db[id] = aggregateEvents;
        callback(null);
    };
    return InMemoryEventSourcedRepository;
})();
exports.InMemoryEventSourcedRepository = InMemoryEventSourcedRepository;

var EventSourceRepositoryWithNotifications = (function () {
    function EventSourceRepositoryWithNotifications(repository, onSaveCallback) {
        this.repository = repository;
        this.onSaveCallback = onSaveCallback;
    }
    EventSourceRepositoryWithNotifications.prototype.getEventsByAggregateId = function (id, callback) {
        this.repository.getEventsByAggregateId(id, callback);
    };

    EventSourceRepositoryWithNotifications.prototype.saveEventsByAggregateId = function (id, events, callback) {
        var self = this;
        this.repository.saveEventsByAggregateId(id, events, function (error) {
            if (!error) {
                self.onSaveCallback(id, events);
            }

            callback(error);
        });
    };
    return EventSourceRepositoryWithNotifications;
})();
exports.EventSourceRepositoryWithNotifications = EventSourceRepositoryWithNotifications;

var RedisEventSourcedRepository = (function (_super) {
    __extends(RedisEventSourcedRepository, _super);
    function RedisEventSourcedRepository(options) {
        _super.call(this, options);
    }
    RedisEventSourcedRepository.prototype.getEventsByAggregateId = function (id, callback) {
        var self = this;
        this.getClient().lrange('eventsourcing.aggregate:' + id, 0, -1, function (error, results) {
            self.constructResultsResponse(error, results, callback);
        });
    };

    RedisEventSourcedRepository.prototype.saveEventsByAggregateId = function (id, events, callback) {
        if (!events || events.length === 0) {
            callback(null);
            return;
        }

        var self = this;
        Async.forEachSeries(events, function (versionedEvent, callback) {
            var serializedEvent = JSON.stringify(versionedEvent);
            self.getClient().rpush('eventsourcing.aggregate:' + versionedEvent.sourceId, serializedEvent, function (error) {
                if (error)
                    return callback(error);
                callback(null);
            });
        }, callback);
    };

    RedisEventSourcedRepository.prototype.constructResultsResponse = function (error, results, callback) {
        if (error)
            return callback(error, null);

        if (results && results.length > 0) {
            var arr = [];

            results.forEach(function (item) {
                arr.push(JSON.parse(item));
            });

            return callback(null, arr);
        }

        callback(null, []);
    };
    return RedisEventSourcedRepository;
})(RedisResource);
exports.RedisEventSourcedRepository = RedisEventSourcedRepository;
