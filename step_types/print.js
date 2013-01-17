exports.run = function(testRun, callback) {
  if (!testRun.silencePrints) {
    console.log(testRun.p('text'));
  }
  callback({ 'success': true });
};