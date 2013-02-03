angular.module('podcast.directives', [])
    .directive('pullToRefresh', function() {
        return function(scope, element, attrs, feedItems) {
            var myScroll,
                pullDownEl, pullDownOffset;

            pullDownEl = document.getElementById('pullDown');
            pullDownOffset = pullDownEl.offsetHeight;

            //TODO: get ID from context somehow?
            myScroll = new iScroll(element[0], {
                useTransition: true,
                topOffset: pullDownOffset,
                onRefresh: function () {
                    if (pullDownEl.className.match('loading')) {
                        pullDownEl.className = '';
                        pullDownEl.querySelector('.pullDownLabel').innerHTML = 'Pull down to refresh...';
                    }
                },
                onScrollMove: function () {
                    if (this.y > 5 && !pullDownEl.className.match('flip')) {
                        pullDownEl.className = 'flip';
                        pullDownEl.querySelector('.pullDownLabel').innerHTML = 'Release to refresh...';
                        this.minScrollY = 0;
                    } else if (this.y < 5 && pullDownEl.className.match('flip')) {
                        pullDownEl.className = '';
                        pullDownEl.querySelector('.pullDownLabel').innerHTML = 'Pull down to refresh...';
                        this.minScrollY = -pullDownOffset;
                    }
                },
                onScrollEnd: function () {
                    if (pullDownEl.className.match('flip')) {
                        pullDownEl.className = 'loading';
                        pullDownEl.querySelector('.pullDownLabel').innerHTML = 'Loading...';

                        scope.downloadItems(function(feedItem, feed) {
                            if (undefined === feed) {
                                myScroll.refresh();
                            } else {
                                pullDownEl.querySelector('.pullDownLabel').innerHTML = 'Loading ' + feed.title + '...';
                            }
                        });
                    }
                }
            });

            scope.$watch(
                function() { return scope.queue; },
                function() { myScroll.refresh(); },
                true
            );
        }
    })
    .directive('hold', ['$timeout', function($timeout) {
        return function(scope, element, attrs) {
            var startTime, moved, holdTimer = false;
            element.bind('touchstart', function(event) {
                startTime = new Date().getTime();

                $timeout.cancel(holdTimer);
                holdTimer = $timeout(function() {
                    scope.$eval(attrs.hold);
                }, 500);
            });
            element.bind('touchmove', function() {
                $timeout.cancel(holdTimer);
            });
            element.bind('touchend', function(event) {
                if (new Date().getTime() - startTime > 500) {
                    event.preventDefault();
                } else {
                    $timeout.cancel(holdTimer);
                    element[0].click();
                }
            });
        }
    }])
;