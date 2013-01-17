exports.cmp = "title";
exports.run = function(testRun, callback) {
  testRun.wd.title(function(err, title) {
    callback({'value': title, 'error': err});
  });
};