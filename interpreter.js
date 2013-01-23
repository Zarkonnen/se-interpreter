#!/usr/bin/env node

/*
* Copyright 2013 Sauce Labs
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
* http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

var webdriver = require('wd');
var S = require('string');

// Common functionality for assert/verify/waitFor/store step types. Only the code for actually
// getting the value has to be implemented individually.
var prefixes = {
  'assert': function(getter, testRun, callback) {
    getter.run(testRun, function(info) {
      if (info.error) { callback(info); return; }
      var match = getter.cmp ? info.value == testRun.p(getter.cmp) : info.value;
      
      if (testRun.currentStep().negated) {
        if (match) {
          callback({ 'success': false, 'error': getter.cmp ? getter.cmp + ' matches' : getter.name + ' is true' });
        } else {
          callback({ 'success': true });
        }
      } else {
        if (match) {
          callback({ 'success': true });
        } else {
          callback({ 'success': false, 'error': getter.cmp ? getter.cmp + ' does not match' : getter.name + ' is false' });
        }
      }
    });
  },
  'verify': function(getter, testRun, callback) {
    getter.run(testRun, function(info) {
      if (info.error) { callback(info); return; }
      callback({ 'success': !!((getter.cmp ? info.value == testRun.p(getter.cmp) : info.value) ^ testRun.currentStep().negated) });
    });
  },
  'store': function(getter, testRun, callback) {
    getter.run(testRun, function(info) {
      if (info.error) { callback(info); return; }
      testRun.setVar(testRun.p('variable'), info.value);
      callback({ 'success': true });
    });
  },
  'waitFor': function(getter, testRun, callback) {
    var ticks = 60000 / 500;
    var tick = 0;
    function test() {
      getter.run(testRun, function(info) {
        if (!info.error && !!((getter.cmp ? info.value == testRun.p(getter.cmp) : info.value) ^ testRun.currentStep().negated)) {
          callback({ 'success': true });
        } else {
          if (tick++ < ticks) {
            setTimeout(test, 500);
          } else {
            callback({ 'success': false, 'error': info.error || 'Wait timed out.' });
          }
        }
      }); 
    }
    
    setTimeout(test, 500);
  }
};

/** Creates step executors by loading them as modules from step_types. */
var DefaultExecutorFactory = function() {
  this.executors = {};
};
DefaultExecutorFactory.prototype.get = function(stepType) {
  if (!this.executors[stepType]) {
    try {
      this.executors[stepType] = require('./step_types/' + stepType + '.js');
    } catch (e) {
      return null;
    }
  }
  return this.executors[stepType];
};

/** Encapsulates a single test run. */
var TestRun = function(script, name) {
  this.vars = {};
  this.script = script;
  this.stepIndex = -1;
  this.wd = null;
  this.silencePrints = false;
  this.name = name || 'Untitled';
  this.browserOptions = { 'browserName': 'firefox' };
  this.listener = null;
  this.success = true;
  this.lastError = null;
  this.executorFactories = [new DefaultExecutorFactory()];
};

TestRun.prototype.start = function(callback) {
  callback = callback || function() {};
  this.wd = webdriver.remote();
  this.browserOptions.name = this.name;
  var testRun = this;
  this.wd.init(this.browserOptions, function(err) {
    var info = { 'success': !err, 'error': err };
    if (testRun.listener && testRun.listener.startTestRun) {
      testRun.listener.startTestRun(testRun, info);
    }
    callback(info);
  });
};

TestRun.prototype.currentStep = function() {
  return this.script.steps[this.stepIndex];
};

TestRun.prototype.hasNext = function() {
  return this.stepIndex + 1 < this.script.steps.length;
};

TestRun.prototype.next = function(callback) {
  callback = callback || function() {};
  this.stepIndex++;
  if (this.listener && this.listener.startStep) {
    this.listener.startStep(this, this.currentStep());
  }
  var stepType = this.currentStep().type;
  var prefix = null;
  for (var p in prefixes) {
    if (S(stepType).startsWith(p) && stepType != p) {
      prefix = prefixes[p];
      stepType = stepType.substring(p.length);
      break;
    }
  }
  var executor = null;
  var i = 0;
  while (!executor && i < this.executorFactories.length) {
    executor = this.executorFactories[i++].get(stepType);
  }
  if (!executor) {
    var info = { 'success': false, 'error': 'Unable to load step type ' + stepType + '.' };
    if (this.listener && this.listener.endStep) {
      this.listener.endStep(this, this.currentStep(), info);
    }
    callback(info);
    return;
  }
  var testRun = this;
  var wrappedCallback = callback;
  wrappedCallback = function(info) {
    testRun.success = testRun.success && info.success;
    testRun.lastError = info.error || testRun.lastError;
    if (testRun.listener && testRun.listener.endStep) {
      testRun.listener.endStep(testRun, testRun.currentStep(), info);
    }
    callback(info);
  };
  try {
    if (prefix) {
      prefix(executor, this, wrappedCallback);
    } else {
      executor.run(this, wrappedCallback);
    }
  } catch (e) {
    wrappedCallback({ 'success': false, 'error': e });
  }
};

TestRun.prototype.end = function(callback) {
  callback = callback || function() {};
  if (this.wd) {
    var wd = this.wd;
    this.wd = null;
    var testRun = this;
    wd.quit(function(error) {
      var info = { 'success': testRun.success && !error, 'error': testRun.lastError || error };
      if (testRun.listener && testRun.listener.endTestRun) {
        testRun.listener.endTestRun(testRun, info);
      }
      callback(info);
    });
  } else {
    var info = { 'success': false, 'error': 'No driver running.' };
    if (this.listener && this.listener.endTestRun) {
      this.listener.endTestRun(testRun, info);
    }
    callback(info);
  }
};

TestRun.prototype.run = function(runCallback, stepCallback) {
  var testRun = this;
  runCallback = runCallback || function() {};
  stepCallback = stepCallback || function() {};
  try {
    this.start(function(info) {
      if (!info.success) {
        runCallback({ 'success': false, 'error': 'Unable to start playback session: ' + info.error });
        return;
      }
      function runStep() {
        testRun.next(function(info) {
          stepCallback(info);
          if (info.error) {
            testRun.end(function(endInfo) {
              runCallback({'success': false, 'error': (endInfo.error && info.error != endInfo.error) ? info.error + '\nAdditionally, the following error occurred while shutting down: ' + endInfo.error : info.error });
            });
            return;
          }
          if (testRun.hasNext()) {
            runStep();
          } else {
            testRun.end(function(endInfo) { runCallback({ 'success': testRun.success && endInfo.success, 'error': testRun.lastError || endInfo.error }); });
          }
        });
      }
      runStep();
    });
  } catch (e) {
    testRun.end(function(endInfo) {
      runCallback({'success': false, 'error': endInfo.error ? 'Unable to start session: ' + e + '\nAdditionally, the following error occurred while shutting down: ' + endInfo.error : 'Unable to start session: ' + e });
    });
  };
};

TestRun.prototype.reset = function() {
  this.end();
  this.vars = {};
  this.stepIndex = -1;
  this.success = true;
  this.lastError = null;
};

TestRun.prototype.setVar = function(k, v) {
  this.vars[k] = v;
};

TestRun.prototype.p = function(name) {
  var s = this.currentStep();
  if (!(name in s)) {
    throw 'Missing parameter "' + name + '" in step #' + (this.stepIndex + 1) + '.'; 
  }
  var v = s[name];
  for (var k in this.vars) {
    v = v.replace(new RegExp("\\$\\{" + k + "\\}", "g"), this.vars[k]);
  }
  return v;
};

/**
 * Calls a function on the webdriver, and defaults to calling the callback with success/failure.
 * @param fName The function to call.
 * @param args List of arguments.
 * @param callback stepCallback that's invoked by default.
 * @param successCallback If specified, called on success instead of calling callback.
 * @param failureCallback If specified, called on success instead of calling callback.
 */
TestRun.prototype.do = function(fName, args, callback, successCallback, failureCallback) {
  if (!this.wd[fName]) {
    if (failureCallback) {
      failureCallback('Webdriver has no function "' + fName + '".');
    } else {
      cb({'success': false, 'error': 'Webdriver has no function "' + fName + '".'});
    }
    return; 
  }
  this.wd[fName].apply(this.wd, args.concat([function(err) {
    if (err) {
      if (failureCallback) {
        failureCallback.apply(failureCallback, arguments);
      } else {
        callback({'success': false, 'error': err});
      }
    } else {
      if (successCallback) {
        successCallback.apply(successCallback, arguments);
      } else {
        callback({'success': true});
      }
    }
  }]));
};

/**
 * Locates an element specified by a locator in the current step.
 * @param locatorName Name of the locator step parameter, usually "locator".
 * @param callback stepCallback that's invoked by default.
 * @param successCallback If specified, called on success instead of calling callback.
 * @param failureCallback If specified, called on success instead of calling callback.
 */
TestRun.prototype.locate = function(locatorName, callback, successCallback, failureCallback) {
  var locator = this.currentStep()[locatorName];
  if (!locator) {
    callback('Missing parameter "' + locatorName + '" in step #' + (this.stepIndex + 1) + '.');
    return;
  }
  this.wd[{
    'id': 'elementById',
    'name': 'elementByName',
    'link text': 'elementByLinkText',
    'css selector': 'elementByCss',
    'xpath': 'elementByXPath'
  }[locator.type]](locator.value, function(err) {
    if (err) {
      if (failureCallback) {
        failureCallback.apply(failureCallback, arguments);
      } else {
        callback({'success': false, 'error': err});
      }
    } else {
      if (successCallback) {
        successCallback.apply(successCallback, arguments);
      } else {
        callback({'success': true});
      }
    }
  });
};

exports.TestRun = TestRun;

// Command-line usage.
if (require.main !== module) {
  return;
}

function getDefaultListener(testRun) {
  return {
    'startTestRun': function(testRun, info) {
      if (info.success) {
        console.log("\x1b[32mStarting test \x1b[30m" + testRun.name);
      } else {
        console.log("\x1b[31mUnable to start test \x1b[30m" + testRun.name + ": " + info.error);
      }
    },
    'endTestRun': function(testRun, info) {
      if (info.success) {
        console.log("\x1b[32m\x1b[1mTest passed\x1b[30m\x1b[0m");
      } else {
        if (info.error) {
          console.log("\x1b[31m\x1b[1mTest failed: \x1b[30m\x1b[0m" + info.error);
        } else {
          console.log("\x1b[31m\x1b[1mTest failed\x1b[30m\x1b[0m");
        }
      }
    },
    'startStep': function(testRun, step) {
      console.log(JSON.stringify(step));
    },
    'endStep': function(testRun, step, info) {
      if (info.success) {
        console.log("\x1b[32mSuccess\x1b[30m");
      } else {
        if (info.error) {
          console.log("\x1b[31mError: \x1b[30m" + info.error);
        } else {
          console.log("\x1b[33mFailed\x1b[30m");
        }
      }
    }
  };
}

var fs = require('fs');
var opt = require('optimist')
  .default('quiet', false).describe('quiet', 'no per-step output')
  .default('noPrint', false).describe('noPrint', 'no print step output')
  .default('silent', false).describe('silent', 'no non-error output')
  .describe('listener', 'path to listener module')
  .describe('executorFactory', 'path to factory for extra type executors')
  .demand(1) // At least 1 script to execute.
  .usage('Usage: $0 [--option value...] [script path...]\n\nPrefix brower options like browserName with "browser-", e.g. "--browser-browserName=firefox".');

var argv = opt.argv;

var browserOptions = { 'browserName': 'firefox' };
for (var k in argv) {
  if (S(k).startsWith('browser-')) {
    browserOptions[k.substring('browser-'.length)] = argv[k];
  }
}

var scripts = argv._.map(function(path) {
  try {
    return { 'script': JSON.parse(fs.readFileSync(path, "UTF-8")), 'name': path.replace(/.*\/|\\/, "").replace(/\.json$/, "") };
  } catch (e) {
    console.error('Unable to parse script ' + path + ': ' + e);
    return null;
  }
}).filter(function(script) { return script != null; });

var listener = null;
if (argv.listener) {
  try {
    listener = require(argv.listener);
  } catch (e) {
    console.error('Unable to load listener module ' + argv.listener + ': ' + e);
    process.exit(78);
  }
}
var exeFactory = null;
if (argv.executorFactory) {
  try {
    exeFactory = require(argv.executorFactory);
  } catch (e) {
    console.error('Unable to load executor factory module ' + argv.executorFactory + ': ' + e);
    process.exit(78);
  }
}

var index = -1;
var successes = 0;
function play() {
  index++;
  if (index < scripts.length) {
    var tr = new TestRun(scripts[index].script, scripts[index].name);
    tr.silencePrints = argv.noPrint || argv.silent;
    tr.browserOptions = browserOptions;
    if (listener) {
      tr.listener = listener.getInterpreterListener(tr);
    } else {
      if (!argv.silent && !argv.quiet) {
        tr.listener = getDefaultListener(tr);
      }
    }
    if (exeFactory) {
      tr.executorFactories.splice(0, 0, exeFactory);
    }
    tr.run(function(info) {
      if (!argv.silent) {
        if (info.success) {
          successes++;
        }
      }
      play();
    });
  } else {
    if (!argv.silent) {
      console.log("\x1b[" + (successes == scripts.length ? "32" : "31") + "m\x1b[1m" + successes + '/' + scripts.length + ' tests ran successfully. Exiting.\x1b[30m\x1b[0m');
    }
    process.exit(successes == scripts.length ? 0 : 1);
  }
}
play();