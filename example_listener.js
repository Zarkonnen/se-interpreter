exports.getInterpreterListener = function(testRun) {
  return {
    'startTestRun': function(testRun, info) {
      console.log("Listener: test run starting!");
      console.log("Listener: success: " + info.success);
      console.log("Listener: error: " + info.error);
    },
    'endTestRun': function(testRun, info) {
      console.log("Listener: test run ending!");
      console.log("Listener: success: " + info.success);
      console.log("Listener: error: " + info.error);
    },
    'startStep': function(testRun, step) {
      console.log("Listener: step starting!");
      console.log("Listener: " + JSON.stringify(step));
    },
    'endStep': function(testRun, step, info) {
      console.log("Listener: step starting!");
      console.log("Listener: " + JSON.stringify(step));
      console.log("Listener: success: " + info.success);
      console.log("Listener: error: " + info.error);
    }
  };
};