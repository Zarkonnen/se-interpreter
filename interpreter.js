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

process.setMaxListeners(0);

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

var TestRun = function(script, name) {
  this.vars = {};
  this.script = script;
  this.stepIndex = -1;
  this.stepExecutors = {};
  this.wd = null;
  this.defaultLogging = false;
  this.silencePrints = false;
  this.name = name || 'Untitled';
  this.browserOptions = { 'browserName': 'firefox' };
  this.listener = null;
  this.success = true;
  this.lastError = null;
};

TestRun.prototype.start = function(callback) {
  callback = callback || function() {};
  this.wd = webdriver.remote();
  this.browserOptions.name = this.name;
  var testRun = this;
  this.wd.init(this.browserOptions, function(err) {
    var info = { 'success': !err, 'error': err };
    if (testRun.listener && testRun.listener.startTestRun) {
      testRun.listener.startTestRun(this, info);
    }
    if (this.defaultLogging) {
      console.log('Started up session for "' + this.name + '".');
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
  var stepType = this.currentStep().type;
  if (this.defaultLogging) {
    console.log(JSON.stringify(this.currentStep()));
  }
  if (this.listener && this.listener.startStep) {
    this.listener.startStep(this, this.currentStep());
  }
  var prefix = null;
  for (var p in prefixes) {
    if (S(stepType).startsWith(p) && stepType != p) {
      prefix = prefixes[p];
      stepType = stepType.substring(p.length);
      break;
    }
  }
  if (!(stepType in this.stepExecutors)) {
    try {
      this.stepExecutors[stepType] = require('./step_types/' + stepType + '.js');
    } catch (e) {
      var info = { 'success': false, 'error': 'Unable to load step type: ' + e };
      if (this.listener && this.listener.endStep) {
        this.listener.endStep(this, this.currentStep(), info);
      }
      callback(info);
      return;
    }
  }
  var testRun = this;
  var wrappedCallback = callback;
  if (this.defaultLogging) {
    wrappedCallback = function(info) {
      testRun.success = testRun.success && info.success;
      testRun.lastError = info.error || testRun.lastError;
      if (info.success) {
        console.log("Success!");
      } else {
        if (info.error) {
          console.log("Error: " + info.error);
        } else {
          console.log("Failure!");
        }
      }
      if (testRun.listener && testRun.listener.endStep) {
        testRun.listener.endStep(testRun, testRun.currentStep(), info);
      }
      callback(info);
    };
  } else {
    wrappedCallback = function(info) {
      testRun.success = testRun.success && info.success;
      testRun.lastError = info.error || testRun.lastError;
      if (testRun.listener && testRun.listener.endStep) {
        testRun.listener.endStep(testRun, testRun.currentStep(), info);
      }
      callback(info);
    };
  }
  try {
    if (prefix) {
      prefix(this.stepExecutors[stepType], this, wrappedCallback);
    } else {
      this.stepExecutors[stepType].run(this, wrappedCallback);
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
      if (testRun.defaultLogging) {
        console.log("Ended session.");
      }
      var info = { 'success': testRun.success && !error, 'error': testRun.lastError || error };
      if (testRun.listener && testRun.listener.endTestRun) {
        testRun.listener.endTestRun(testRun, info);
      }
      callback(info);
    });
  } else {
    if (this.defaultLogging) {
      console.log("Session already ended: no driver running.");
    }
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
       runCallback({ 'success': false, 'error': 'Unable to start playback session: ' +  info.error });
       return;
      }
      function runStep() {
        testRun.next(function(info) {
          stepCallback(info);
          if (info.error) {
            testRun.end(function(endInfo) { runCallback({ 'success': false, 'error': endInfo.error ? info.error + '\nAdditionally, the following error occurred while shutting down: ' + endInfo.error : info.error }); });
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
    runCallback({ 'success': false, 'error': 'Unable to start session: ' + e });
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

// Command-line usage:
if (require.main !== module) {
  return;
}

var fs = require('fs');
var opt = require('optimist')
  .default('quiet', false).describe('quiet', 'no per-step output')
  .default('noPrint', false).describe('noPrint', 'no print step output')
  .default('silent', false).describe('silent', 'no non-error output')
  .describe('listener', 'path to listener module')
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
    process.exit();
  }
}

var index = -1;
var successes = 0;
function play() {
  index++;
  if (index < scripts.length) {
    var tr = new TestRun(scripts[index].script, scripts[index].name);
    tr.defaultLogging = !argv.silent && !argv.quiet;
    tr.silencePrints = argv.noPrint || argv.silent;
    tr.browserOptions = browserOptions;
    if (listener) {
      tr.listener = listener.getInterpreterListener(tr);
    }
    tr.run(function(info) {
      if (!argv.silent) {
        if (info.success) {
          successes++;
          console.log('"' + scripts[index].name + '" ran successfully.');
        } else {
          if (info.error) {
            console.log(scripts[index].name + ' failed: ' + info.error);
          } else {
            console.log(scripts[index].name + ' failed.');
          }
        }
      }
      play();
    });
  } else {
    if (!argv.silent) { console.log(successes + '/' + scripts.length + ' tests ran successfully. Exiting.'); }
    process.exit();
  }
}
play();