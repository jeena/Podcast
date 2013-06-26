'use strict';

/* Services */
angular.module('podcasts.services', ['podcasts.utilities'])
    .service('downloaderBackend', ['$http', '$q', 'xmlParser', '$rootScope', function($http, $q, xmlParser, $rootScope) {
        return {
            downloadFile: function(url) {
                var deferred = $q.defer();

                $http.get(url, {'responseType': 'blob'})
                    .success(function(file) {
                        deferred.resolve(file);
                    })
                    .error(function() {
                        deferred.reject();
                    })
                ;

                return deferred.promise;
            },
            downloadXml: function(url) {
                var deferred = $q.defer();

                $rootScope.$apply($http.get(url)
                    .success(function(xml) {
                        deferred.resolve(xmlParser.parse(xml));
                    })
                    .error(function(data, status, headers, config) {
                        deferred.reject();
                    })
                );

                return deferred.promise;
            }
        }
    }])
    .value('queueList', {
        queue: [],
        scope: null,
        init: function(scope) {
            this.scope = scope;
            scope.queue = this.queue = [];

        },
        addToQueue: function(item) {
            this.queue.push(item);
            if (typeof this.scope !== "undefined") {
                this.scope.$apply();
            }
        }
    })
    .service('feedItems', ['dbNew', 'db', '$q', function(db, oldDb, $q) {
        return {
            get: function(id, onSuccess, onFailure) {
                db.getOne("feedItem", id)
                    .then(function(value) {
                        onSuccess(value);
                    }, function() {
                        onFailure();
                    });
            },
            getFeedItemFromXml: function(xml) {
                var newFeedItem = {},
                    searchableXml = angular.element(xml);
                newFeedItem.guid = searchableXml.find('guid').text();
                newFeedItem.title = searchableXml.find('title').text();
                newFeedItem.link = searchableXml.find('link').text();
                newFeedItem.date = Date.parse(searchableXml.find('pubDate').text());
                newFeedItem.description = searchableXml.find('description').text();
                newFeedItem.audioUrl = searchableXml.find('enclosure').attr('url');

                return newFeedItem;
            },
            delete: function(id) {
                oldDb.delete("feedItem", id);
            },
            deleteByFeedId: function(feedId) {
                oldDb.getCursor("feedItem", function(ixDbCursorReq) {
                    if (typeof ixDbCursorReq !== "undefined") {
                        ixDbCursorReq.onsuccess = function(e) {
                            var cursor = ixDbCursorReq.result || e.result;
                            if (cursor) {
                                this.delete(cursor.value.id);
                            }
                        }
                    }
                }, null, IDBKeyRange.only(feedId), null, 'ixFeedId');
            },
            add: function(object) {
                var deferred = $q.defer(),
                    newFeedItem = {
                    guid: object.guid,
                    feedId: object.feedId,
                    title: object.title,
                    link: object.link,
                    date: object.date,
                    description: object.description,
                    audioUrl: object.audioUrl,
                    queued: object.queued
                };

                oldDb.put("feedItem", newFeedItem, undefined, function() {
                    deferred.resolve(newFeedItem);
                });

                return deferred.promise;
            },
            getNextInQueue: function(feedItem) {
                var tempQueueList = { queue: [], addToQueue: function(item) { this.queue.push(item); } };
                var nextFeedItem = null;
                this.listQueue(tempQueueList, function() {
                    var returnNextValue = false;
                    angular.forEach(tempQueueList.queue, function(key, value) {
                        if (returnNextValue) {
                            nextFeedItem = value;
                            returnNextValue = false;
                        }
                        if (feedItem.id === value.id) {
                            returnNextValue = true;
                        }
                    });
                });

                return nextFeedItem;
            },
            listQueue: function(queueList, done) {
                oldDb.getCursor("feedItem", function(ixDbCursorReq)
                {
                    if(typeof ixDbCursorReq !== "undefined") {
                        ixDbCursorReq.onsuccess = function (e) {
                            var cursor = ixDbCursorReq.result || e.result;
                            if (cursor) {
                                queueList.addToQueue(cursor.value);

                                cursor.continue();
                            } else {
                                if (typeof done === 'function') {
                                    done();
                                }
                            }
                        }
                    }
                }, undefined, IDBKeyRange.only(1), undefined, 'ixQueued');
            }
        }
    }])
    .service('feeds', ['$log', '$q', 'dbNew', 'db', 'downloaderBackend', 'xmlParser', 'feedItems', 'utilities', function($log, $q, db, dbOld, downloaderBackend, xmlParser, feedItems, utilities) {
        return {
            feeds: [],
            add: function(url) {
                var feedService = this;
                var finishSave = function(newFeed) {
                    dbOld.put("feed", newFeed, undefined, function(key) {
                        newFeed.id = key;

                        feedService.feeds.push(newFeed);
                        feedService.downloadItems(newFeed);
                    });
                };

                var cleanedUrl = utilities.clean_url(url);

                var promise = downloaderBackend.downloadXml(cleanedUrl);
                promise.then(function(xml) {
                    var channelChildren = xml.find('channel').children(),
                        newFeed = {},
                        imageUrl;

                    angular.forEach(channelChildren, function(value, key) {
                        if ('itunes:image' === angular.element(value)[0].nodeName.toLowerCase()) {
                            imageUrl = angular.element(value).attr('href');
                        }

                        if ('itunes:author' === angular.element(value)[0].nodeName.toLowerCase()) {
                            newFeed.author = angular.element(value).text();
                        }
                    });

                    newFeed.url = cleanedUrl;
                    newFeed.title = channelChildren.find('title').text();
                    newFeed.summary = channelChildren.find('description').text();
                    newFeed.nrQueueItems = 1;

                    var file = downloaderBackend.downloadFile(imageUrl);
                    file.then(function(fileBlob) {
                        newFeed.image = fileBlob;
                        finishSave(newFeed);
                    }, function() {
                        finishSave(newFeed);
                    });
                }, function() {
                    console.warn('Could not fetch XML for feed, adding just URL for now');
                    var newFeed = {};
                    newFeed.url = cleanedUrl;

                    finishSave(newFeed);
                });
            },
            get: function(id) {
                id = parseInt(id, 10);
                var deferred = $q.defer();

                db.getOne("feed", id)
                    .then(function(feed) {
                        if (typeof feed.image === 'string') {
                            feed.image = new Blob([feed.image]);
                        }

                        dbOld.getCursor("feedItem", function(ixDbCursorReq)
                        {
                            feed.items = [];
                            if(typeof ixDbCursorReq !== "undefined") {
                                ixDbCursorReq.onsuccess = function (e) {
                                    var cursor = ixDbCursorReq.result || e.result;
                                    if (cursor) {
                                        feed.items.push(cursor.value);

                                        cursor.continue();
                                    } else {
                                        deferred.resolve(feed);
                                    }
                                }
                            }
                        }, null, IDBKeyRange.only(feed.id), undefined, 'ixFeedId');
                    }, function(value) {
                        deferred.reject();
                    });

                return deferred.promise;
            },
            list: function($scope) {
                var feeds = this.feeds;
                dbOld.getCursor("feed", function(ixDbCursorReq)
                {
                    if(typeof ixDbCursorReq !== "undefined") {
                        ixDbCursorReq.onsuccess = function (e) {
                            var cursor = ixDbCursorReq.result || e.result;
                            if (cursor) {
                                if (typeof cursor.value.image === 'string') {
                                    cursor.value.image = new Blob(
                                        [cursor.value.image],
                                        {type: 'application/octet-stream'}
                                    );
                                }
                                feeds.push(cursor.value);
                                $scope.$apply();

                                cursor.continue();
                            }
                        }
                    }
                });
            },
            delete: function(id) {
                $log.info('Deleting feed with ID ' + id);
                feedItems.deleteByFeedId(id);
                dbOld.delete("feed", id);
            },
            /**
             *
             * @param feedItems
             * @param updateStatus  function that gets called for each item it goes through
             *                      Takes the feedItem as the argument
             */
            downloadAllItems: function(feedItems, updateStatus) {
                var feedService = this;
                dbOld.getCursor("feed", function(ixDbCursorReq)
                {
                    if(typeof ixDbCursorReq !== "undefined") {
                        ixDbCursorReq.onsuccess = function (e) {
                            var cursor = ixDbCursorReq.result || e.result;

                            if (cursor) {
                                feedService.downloadItems(cursor.value, updateStatus);

                                cursor.continue();
                            } else {
                                updateStatus();
                            }
                        }
                    }
                });
            },
            downloadItems: function(feedItem, updateStatus) {
                var promise = downloaderBackend.downloadXml(feedItem.url),
                    feedObjects = [];
                promise.then(function(data) {
                    angular.forEach(
                        data.find('item'),
                        function(element, index) {
                            if (index < 3) { // TODO: this should be a global setting and/or a per-feed setting
                                feedObjects.push(feedItems.getFeedItemFromXml(element))
                            }
                        }
                    );

                    angular.forEach(feedObjects, function(feedObject, index) {
                        feedObject.feedId = feedItem.id;
                        if (0 === index) {
                            feedObject.queued = 1;
                        } else {
                            feedObject.queued = 0;
                        }

                        feedItems.add(feedObject)
                            .then(function(item) {
                                if (typeof updateStatus === 'function') {
                                    updateStatus(item, feedItem);
                                }
                            });
                    });
                });
            }
        }
    }])
    .service('xmlParser', ['$window', function($window) {
        return  {
            parse: function(data) {
                return angular.element(new $window.DOMParser().parseFromString(data, "text/xml"));
            }
        };
    }])
    .service('url', ['$window', function($window) {
        return {
            url: $window.URL || $window.webkitURL,
            createObjectUrl: function(data) {
                return this.url.createObjectUrl(data);
            }
        };
    }])
    .service('player', ['db', 'url', '$timeout', function(db, url, $timeout) {
        var audioSetup = new Audio();
        audioSetup.setAttribute("mozaudiochannel", "content");

        return {
            db: db,
            audio: audioSetup,
            feedItem: null,
            nowPlaying: {position: 0, duration: 0, title: '', description: '', feed: '', date: 0},
            play: function (feedItem, $scope) {
                if (feedItem) {
                    this.feedItem = feedItem;

                    var audioSrc;

                    if (feedItem.audio) {
                        audioSrc = url.createObjectUrl(feedItem.audio);
                    } else {
                        audioSrc = feedItem.audioUrl;
                    }

                    this.audio.src = audioSrc;
                    this.updateSong(feedItem, $scope);

                    if (feedItem.position) {
                        angular.element(this.audio).bind('canplay', function(event) {
                            this.currentTime = feedItem.position;
                        });
                    }
                }
                this.audio.play();

                var db = this.db;
                angular.element(this.audio).bind('pause', function(event) {
                    feedItem.position = Math.floor(event.target.currentTime);
                    db.put("feedItem", feedItem);
                });

                // TODO: add something here for when audio is done to remove from queue and go to next song
                angular.element(this.audio).bind('ended', function(event) {
                    feedItem.queued = 0;
                    feedItem.position = 0;
                    db.put("feedItem", feedItem);

                    // start next item
                    // get next item from queue
                    play(nextFeedItem, $scope);
                });
            },
            pause: function() {
                this.audio[0].pause();
            },
            playing: function() {
                return !this.audio[0].paused;
            },
            updateSong: function(feedItem, $scope) {
                this.nowPlaying.title = feedItem.title;
                var audio = this.audio,
                    player = this;
                $timeout(function() {
                    player.nowPlaying.duration = audio.duration;
                }, 100);
                this.nowPlaying.feedItem = feedItem;
                this.nowPlaying.description = feedItem.description;
                this.nowPlaying.feed = feedItem.feed;
                this.nowPlaying.date = feedItem.date;
                this.updatePosition($scope);
            },
            updatePosition: function($scope) {
                var audio = this.audio,
                    player = this;
                setInterval(function() {
                    player.nowPlaying.position = audio.currentTime;
                    $scope.$apply();
                }, 1000);
            }
        }
    }])
    .service('pageSwitcher', ['$location', '$route', function($location, $route) {
        return {
            //TODO: change these getElementById's to something else
            pageSwitcher: document.getElementById('pageSwitcher'),
            pages: ['queue', 'settings', 'feeds'],
            $route: $route,
            currentPage: null,
            backPage: null,
            change: function(current) {
                this.currentPage = current;
                var nextPage = this.getNextPage(this.currentPage);

                angular.element(document.getElementById('pageswitch-icon-' + this.currentPage))
                    .addClass('next').removeClass('next1 next2');
                angular.element(document.getElementById('pageswitch-icon-' + nextPage))
                    .addClass('next1').removeClass('next next2');
                angular.element(document.getElementById('pageswitch-icon-' + this.getNextPage(nextPage)))
                    .addClass('next2').removeClass('next next1');
            },
            setBack: function(backPage) {
                this.backPage = backPage;
            },
            getNextPage: function(current) {
                var nextPage,
                    pages = this.pages,
                    validRoute = false;

                angular.forEach(pages, function(value, key) {
                    if (current === value) {
                        var nextKey = key + 1;
                        if (pages[nextKey]) {
                            nextPage = pages[nextKey];
                        } else {
                            nextPage = pages[0];
                        }
                    }
                });

                angular.forEach(this.$route.routes, function(value, key) {
                    if (key === '/' + nextPage) {
                        validRoute = true;
                    }
                });
                if (!validRoute) {
                    console.error('no valid route found for pageSwitcher: ' + nextPage);
                }

                return nextPage;
            },
            goToPage: function(page) {
                if (!page) {
                    if (this.backPage) {
                        page = this.backPage;
                    } else {
                        page = this.getNextPage(this.currentPage);
                    }
                }
                if (this.backPage) {
                    this.backPage = null;
                }

                $location.path('/'+page);
            }
        }
    }])
    .service('downloader', ['db', 'url', '$http', 'settings', function(db, url, $http, settings) {
        return {
            allowedToDownload: function(callback) {
                settings.get('downloadOnWifi', function(setting) {
                    if (setting.value) {
                        //TODO: check if we're on wifi
                        callback(false);
                    } else {
                        callback(true);
                    }
                }, function() {
                    callback(true); // Default value is "allowed" - maybe change this?
                });
            },
            downloadAll: function(silent) {
                var downloader = this;
                this.allowedToDownload(function(value) {
                    if (!value) {
                        if (typeof silent !== 'undefined' && !silent) {
                            alert('not Downloading because not on WiFi'); //TODO: nicer error message?
                        }
                    } else {
                        var itemsToDownload = [];
                        db.getCursor("feedItem", function(ixDbCursorReq)
                        {
                            if(typeof ixDbCursorReq !== "undefined") {
                                ixDbCursorReq.onsuccess = function (e) {
                                    var cursor = ixDbCursorReq.result || e.result;

                                    if (cursor) {
                                        if (!cursor.value.audio && cursor.value.audioUrl) {
                                            itemsToDownload.push(cursor.value);
                                        }
                                        cursor.continue();
                                    } else {
                                        downloader.downloadFiles(itemsToDownload);
                                    }
                                }
                            }
                        }, undefined, IDBKeyRange.only(1), undefined, 'ixQueued');
                    }
                });
            },
            downloadFiles: function(itemsToDownload) {
                var item = itemsToDownload.shift(),
                    downloader = this;
                if (!item) {
                    return;
                }

                $http.get(item.audioUrl, {'responseType': 'blob'})
                    .success(function(data) {
                        item.audio = data;
                        item.duration = this.getAudioLength(data);

                        db.put("feedItem", item);

                        downloader.downloadFiles(itemsToDownload);
                    })
                ;
            },
            getAudioLength: function(audio) {
                var tmpAudio = new Audio();
                tmpAudio.autoplay = false;
                tmpAudio.muted = true;
                tmpAudio.src = url.createObjectURL(audio);

                return tmpAudio.duration;
            }
        };
    }])
    .filter('time', function() {
        return function(input, skip) {
            var seconds, minutes, hours;
            seconds = Math.floor(input);

            if (seconds > 120) {
                minutes = Math.floor(seconds/60);

                seconds = seconds % 60;
                if (seconds < 10) {
                    seconds = '0' + seconds;
                }
            }
            if (minutes > 60) {
                hours = Math.floor(minutes/60);

                minutes = minutes % 60;
                if (minutes < 10) {
                    minutes = '0' + minutes;
                }
            }

            if (hours) {
                return hours + ':' + minutes + ':' + seconds;
            } else if (minutes) {
                return minutes + ':' + seconds;
            } else {
                if (skip) {
                    return seconds;
                }
                return seconds + 's';
            }
        }
    })
    .filter('timeAgo', function() {
        return function(timestamp) {
            var diff = ((new Date().getTime()) - (new Date(timestamp).getTime())) / 1000,
                day_diff = Math.floor(diff / 86400);

            return day_diff == 0 && (
                diff < 60 && "just now" ||
                    diff < 120 && "1 minute ago" ||
                    diff < 3600 && Math.floor( diff / 60 ) + " minutes ago" ||
                    diff < 7200 && "1 hour ago" ||
                    diff < 86400 && Math.floor( diff / 3600 ) + " hours ago") ||
                day_diff == 1 && "Yesterday" ||
                day_diff < 7 && day_diff + " days ago" ||
                day_diff < 31 && Math.ceil( day_diff / 7 ) + " weeks ago" ||
                "older than a month";
        }
    });

angular.module('podcasts.database', [])
    .run(function() {
        var dbConfig = (function () {
            //Create IndexedDB ObjectStore and Indexes via ixDbEz
            ixDbEz.createObjStore("feed", "id", true);
            ixDbEz.createIndex("feed", "ixUrl", "url", true);
            ixDbEz.createObjStore("feedItem", "id", true);
            ixDbEz.createIndex("feedItem", "ixGuid", "guid", true);
            ixDbEz.createIndex("feedItem", "ixFeedId", "feedId");
            ixDbEz.createIndex("feedItem", "ixQueued", "queued");
            ixDbEz.createObjStore("setting", "id", true);
            ixDbEz.createIndex("setting", "ixName", "name", true);
        });

        //Create or Open the local IndexedDB database via ixDbEz
        ixDbEz.startDB("podcastDb", 8, dbConfig, undefined, undefined, false);
    })
    .value('db', ixDbEz)
    .service('dbNew', ['$q', '$rootScope', 'db', function($q, $rootScope, _db) {
        var _getOne = function(store, identifier) {
            var deferred = $q.defer();

            _db.getCursor(store, function(ixDbCursorReq)
            {
                if(typeof ixDbCursorReq !== "undefined") {
                    ixDbCursorReq.onsuccess = function (e) {
                        var cursor = ixDbCursorReq.result || e.result;
                        if (cursor) {
                            deferred.resolve(cursor.value);

                            cursor.continue();
                        } else {
                            //TODO: not sure if this'll work, since it may both resolve and reject.
                            // May need to check if any were resolved or not first

                            // deferred.reject();
                        }
                    }
                } else {
                    deferred.reject();
                }
            });

            return deferred.promise;
        };

        return {
            getOne: _getOne
        };
    }]);

angular.module('podcasts.updater', ['podcasts.settings'])
    .run(['update', function(update) {
        update.checkFeeds();
    }])
    .service('update', ['$timeout', '$log', 'settings', 'downloader', function($timeout, $log, settings, downloader) {
        var checkFeeds = function() {
            $log.info('Running Feed Check');

            settings.get('refreshInterval', function(value) {
                if (value.value > 0) {
                    var refreshInterval = value.value;

                    update();

                    if (refreshInterval > 0) {
                        $timeout(checkFeeds, refreshInterval);
                    }
                }
            });
        };

        function update() {
            downloader.downloadAll(true);
        }

        return {
            checkFeeds: checkFeeds,
            update: update
        };
    }])
;

angular.module('podcasts.settings', ['podcasts.database'])
    .run(['settings', function(settings) {
        settings.init();
    }])
    .service('settings', ['db', function(db) {
        var settings = {},
            initialized = false,
            waiting = [];

        function _init() {
            console.log('init settings');
            db.getCursor("setting", function(ixDbCursorReq)
            {
                if(typeof ixDbCursorReq !== "undefined") {
                    ixDbCursorReq.onsuccess = function (e) {
                        var cursor = ixDbCursorReq.result || e.result;
                        if (cursor) {
                            settings[cursor.value.name] = cursor.value;

                            cursor.continue();
                        } else {
                            initialized = true;

                            for (var i = 0, l = waiting.length; i < l; i++) {
                                waiting[i]();
                            }
                        }
                    }
                }
            });
        }

        function _set(name, value, key) {
            var setting;

            if (key) {
                setting = {'id': key, 'name': name, 'value': value};
                if (settings[name]['id'] === key) {
                    settings[name] = setting;
                } else {
                    //TODO: name changed, go through all settings and find the setting by id, and adjust it
                }
            } else {
                setting = {'name': name, 'value': value};
                settings[name] = setting;
                //TODO: get id after inserting into DB
            }

            db.put("setting", setting);
        }

        function _get(name, onSuccess, onFailure) {
            if (!initialized) {
                waiting.push(function() {
                    _get(name, onSuccess, onFailure);
                });

                return;
            }

            if (!angular.isUndefined(settings[name])) {
                onSuccess(settings[name]);
            } else {
                db.getCursor("setting", function(ixDbCursorReq)
                {
                    if(typeof ixDbCursorReq !== "undefined") {
                        ixDbCursorReq.onsuccess = function (e) {
                            var cursor = ixDbCursorReq.result || e.result;
                            if (cursor) {
                                onSuccess(cursor.value);
                            } else {
                                if (typeof onFailure === 'function') {
                                    onFailure();
                                }
                            }
                        };

                        ixDbCursorReq.onerror = function (e) {
                            console.log('didnt get setting');
                            onFailure();
                        };
                    }
                }, function() { onFailure(); }, IDBKeyRange.only(name), undefined, 'ixName');
            }
        }

        function _setAllValuesInScope(scope) {
            if (angular.isObject(scope.settings.refreshInterval)) { // Took random setting here
                return;
            }

            if (!initialized) {
                waiting.push(function() {
                    _setAllValuesInScope(scope);
                });

                return;
            }

            angular.forEach(settings, function(setting, index) {
                scope.settings[setting.name] = setting;
            });

            scope.$apply(); //TODO: this conflicts with digest when getting to the settings page a second time
        }

        return {
            init: _init,
            set: _set,
            get: _get,
            setAllValuesInScope: _setAllValuesInScope
        };
    }])
;

angular.module('podcasts.importer', [])
    .service('google', ['$q', '$http', 'feeds', function($q, $http, feeds) {
        return {
            import: function(email, password) {
                var google = this;

                this.auth(email,
                        password)
                    .then(function(authId) {
                        return google.fetchSubscriptions(authId)
                    }, function() {
                        //TODO: display error
                    })
                    .then(function(subscriptions) {
                        google.addFeedsFromJsonResponse(subscriptions);
                    })
                ;
            },
            auth: function(email, password) {
                var escapedEmail = encodeURIComponent(email),
                    escapedPassword = encodeURIComponent(password),
                    deferred = $q.defer();

                $http.post(
                    'https://www.google.com/accounts/ClientLogin',
                    'Email=' + escapedEmail + '&Passwd=' + escapedPassword + '&service=reader',
                    {'headers': {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'}}
                ).success(function(response) {
                    response.split(/\r\n|\r|\n/).forEach(function(value, index) {
                        var valueSplit = value.split('=');
                        if ('Auth' === valueSplit[0]) {
                            deferred.resolve(valueSplit[1]);
                        }
                    });
                }).error(function(data, status, headers, config) {
                    console.log(data, status, headers);
                    deferred.reject();
                });

                return deferred.promise;
            },
            fetchSubscriptions: function(authId) {
                var deferred = $q.defer();

                $http
                    .get(
                        'http://www.google.com/reader/api/0/subscription/list?output=json',
                        {'headers': {'Authorization': 'GoogleLogin auth=' + authId}}
                    )
                    .success(function(json) {
                        deferred.resolve(json);
                    })
                    .error(function(data, status, headers, config) {
                        deferred.reject();
                    })
                ;

                return deferred.promise;
            },
            addFeedsFromJsonResponse: function(json) {
                json.subscriptions.forEach(function(subscription, subscriptionIndex) {
                    if (subscription.categories.length <= 0) {
                        return false;
                    }

                    subscription.categories.forEach(function(category, categoryIndes) {
                        if ("Listen Subscriptions" === category.label) {
                            var feedUrl = subscription.id;
                            if ("feed/" === feedUrl.substring(0, 5)) {
                                feedUrl = feedUrl.substring(5);
                            }

                            feeds.add(feedUrl);
                        }
                    });
                });
            }
        };
    }])
;