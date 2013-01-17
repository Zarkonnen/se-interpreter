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
  this.defaultLogging = true;
  this.silencePrints = false;
  this.name = name || 'Untitled';
  this.browserOptions = { 'browserName': 'firefox' };
};

TestRun.prototype.start = function(callback) {
  if (this.defaultLogging) {
    console.log('Starting up session for "' + this.name + '".');
  }
  this.wd = webdriver.remote();
  this.browserOptions.name = this.name;
  this.wd.init(this.browserOptions, function(err) { callback({ 'success': !err, 'error': err }); });
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
  var prefix = null;
  for (var p in prefixes) {
    if (S(stepType).startsWith(p)) {
      prefix = prefixes[p];
      stepType = stepType.substring(p.length);
      break;
    }
  }
  if (!(stepType in this.stepExecutors)) {
    try {
      this.stepExecutors[stepType] = require('./step_types/' + stepType + '.js');
    } catch (e) {
      callback({ 'success': false, 'error': 'Unable to load step type: ' + e });
      return;
    }
  }
  var wrappedCallback = callback;
  if (this.defaultLogging) {
    wrappedCallback = function(info) {
      if (info.success) {
        console.log("Success!");
      } else {
        if (info.error) {
          console.log("Error: " + info.error);
        } else {
          console.log("Failure!");
        }
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
    callback({ 'success': false, 'error': e });
  }
};

TestRun.prototype.end = function(callback) {
  if (this.wd) {
    if (this.defaultLogging) {
      console.log("Ending session.");
    }
    var wd = this.wd;
    this.wd = null;
    wd.quit(callback);
  } else {
    callback('No driver running.');
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
      function runStep(success) {
        testRun.next(function(info) {
          stepCallback(info);
          if (info.error) {
            testRun.end(function(err) { runCallback({ 'success': false, 'error': err ? info.error + '\nAdditionally, the following error occurred while shutting down: ' + err : info.error }); });
            return;
          }
          success = success && info.success;
          if (testRun.hasNext()) {
            runStep(success);
          } else {
            testRun.end(function(err) { runCallback({ 'success': success && !err, 'error': err }); });
          }
        });
      }
      runStep(true);
    });
  } catch (e) {
    runCallback({ 'success': false, 'error': 'Unable to start session: ' + e });
  };
};

TestRun.prototype.reset = function() {
  this.end();
  this.vars = {};
  this.stepIndex = -1;
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

///

var fs = require('fs');
var opt = require('optimist')
  .default('quiet', false).describe('quiet', 'no per-step output')
  .default('noPrint', false).describe('noPrint', 'no print step output')
  .default('silent', false).describe('silent', 'no non-error output')
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

var index = -1;
var successes = 0;
function play() {
  index++;
  if (index < scripts.length) {
    var tr = new TestRun(scripts[index].script, scripts[index].name);
    tr.defaultLogging = !argv.silent && !argv.quiet;
    tr.silencePrints = argv.noPrint || argv.silent;
    tr.browserOptions = browserOptions;
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