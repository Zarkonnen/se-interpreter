exports.run = function(testRun, callback) {
  testRun.wd.get(testRun.p('url'), function(err) {
    callback({'success': !err, 'error': err});
  });
};