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

var interpreter_version = "1.0.5";
var webdriver = require('wd');
var S = require('string');
var glob = require('glob');
var util = require('util');
var pathLib = require('path');
var fs = require('fs');
var colors = require('colors');
var libxml = require('libxmljs');

// Common functionality for assert/verify/waitFor/store step types. Only the code for actually
// getting the value has to be implemented individually.
var prefixes = {
  'assert': function(getter, testRun, callback) {
    getter.run(testRun, function(info) {
      if (info.error) { callback(info); return; }
      var match = getter.cmp ? info.value == testRun.p(getter.cmp) : info.value;

      if (testRun.currentStep().negated) {
        if (match) {
          callback({'success': false,
                    'error': new Error(getter.cmp ?
                                       getter.cmp + ' matches' :
                                       getter.name + ' is true') });
        } else {
          callback({ 'success': true });
        }
      } else {
        if (match) {
          callback({ 'success': true });
        } else {
          callback({'success': false,
                    'error': new Error(getter.cmp ?
                                       getter.cmp + ' does not match' :
                                       getter.name + ' is false') });
        }
      }
    });
  },
  'verify': function(getter, testRun, callback) {
    getter.run(testRun, function(info) {
      if (info.error) { callback(info); return; }
      callback({ 'success': !!((getter.cmp ?
                                info.value == testRun.p(getter.cmp) :
                                info.value) ^ testRun.currentStep().negated) });
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
        if (!info.error && !!((getter.cmp ?
                              info.value == testRun.p(getter.cmp) :
                              info.value) ^ testRun.currentStep().negated)) {
          callback({ 'success': true });
        } else {
          if (tick++ < ticks) {
            setTimeout(test, 500);
          } else {
            callback({ 'success': false, 'error': info.error || new Error('Wait timed out.') });
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
var TestRun = function(script, name, initialVars) {
  this.initialVars = initialVars || {};
  this.vars = {};
  for (var k in this.initialVars) {
    this.vars[k] = this.initialVars[k];
  }
  this.script = script;
  this.stepIndex = -1;
  this.wd = null;
  this.silencePrints = false;
  this.name = name || 'Untitled';
  this.browserOptions = { 'browserName': 'firefox' };
  this.driverOptions = {};
  this.listener = null;
  this.success = true;
  this.lastError = null;
  this.executorFactories = [new DefaultExecutorFactory()];
};

TestRun.prototype.start = function(callback) {
  callback = callback || function() {};
  this.wd = webdriver.remote(this.driverOptions);
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
    var info = { 'success': false, 'error': new Error('Unable to load step type ' + stepType + '.') };
    this.lastError = info.error;
    this.success = false;
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
  var testRun = this;
  if (this.wd) {
    var wd = this.wd;
    this.wd = null;
    wd.quit(function(error) {
      var info = { 'success': testRun.success && !error, 'error': testRun.lastError || error };
      if (testRun.listener && testRun.listener.endTestRun) {
        testRun.listener.endTestRun(testRun, info);
      }
      callback(info);
    });
  } else {
    var info = { 'success': false, 'error': new Error('No driver running.') };
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
        var err = new Error('Unable to start playback session.');
        err.reason = info.error;
        runCallback({ 'success': false, 'error': err });
        return;
      }
      function runStep() {
        testRun.next(function(info) {
          stepCallback(info);
          if (info.error) {
            testRun.end(function(endInfo) {
              if (endInfo.error) {
                info.additionalError = endInfo.error;
              }
              runCallback({'success': false, 'error': info.error});
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
      var err = new Error('Unable to start playback session.');
      err.reason = e;
      if (endInfo.error) {
        info.additionalError = endInfo.error;
      }
      runCallback({'success': false, 'error': err });
    });
  }
};

TestRun.prototype.reset = function() {
  this.end();
  this.vars = {};
  for (var k in this.initialVars) {
    this.vars[k] = this.initialVars[k];
  }
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
    throw new Error('Missing parameter "' + name + '" in step #' + (this.stepIndex + 1) + '.');
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
      failureCallback(new Error('Webdriver has no function "' + fName + '".'));
    } else {
      callback({'success': false, 'error': new Error('Webdriver has no function "' + fName + '".') });
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

function getInterpreterListener(testRun) {
  return {
    'startTestRun': function(testRun, info) {
      if (info.success) {
        console.log(testRun.name + ": " + "Starting test ".green +" ("+ testRun.browserOptions.browserName +") ".yellow + testRun.name );
      } else {
        console.log(testRun.name + ": " + "Unable to start test ".red + testRun.name + ": " + util.inspect(info.error));
      }
    },
    'endTestRun': function(testRun, info) {
      if (info.success) {
        console.log(testRun.name + ": " + "Test passed".green);
      } else {
        if (info.error) {
          console.log(testRun.name + ": " + "Test failed: ".red + util.inspect(info.error));
        } else {
          console.log(testRun.name + ": " + "Test failed ".red);
        }
      }
    },
    'startStep': function(testRun, step) {
    },
    'endStep': function(testRun, step, info) {
      if (info.success) {
        console.log(testRun.name + ": " + "Success ".green + JSON.stringify(step).grey);
      } else {
        if (info.error) {
          console.log(testRun.name + ": " + "Failed ".red + util.inspect(info.error));
        } else {
          console.log(testRun.name + ": " + "Failed ".red);
        }
      }
    }
  };
}

function parseJSONFile(path, testRuns, silencePrints, listenerFactory, exeFactory, browserOptions, driverOptions, listenerOptions, dataSources) {
  var rawData = fs.readFileSync(path, "UTF-8");
  var data = JSON.parse(subEnvVars(rawData));
  if (data.type == 'script') {
    parseScriptFile(path, data, testRuns, silencePrints, listenerFactory, exeFactory, browserOptions, driverOptions, listenerOptions, dataSources);
  } else if (data.type == 'interpreter-config') {
    parseConfigFile(data, testRuns, silencePrints, listenerFactory, exeFactory, listenerOptions, dataSources);
  } else if (data.type == 'suite') {
    parseSuiteFile(path, data, testRuns, silencePrints, listenerFactory, exeFactory, browserOptions, driverOptions, listenerOptions, dataSources);
  } else {
    throw new Error("No type property set in JSON file \"" + path + "\".")
  }
}

/** Parses a config JSON file and adds the resulting TestRuns to testRuns. */
function parseConfigFile(fileContents, testRuns, silencePrints, listenerFactory, exeFactory, listenerOptions, dataSources) {
  fileContents.configurations.forEach(function(config) {
    var settingsList = config.settings;
    if (!settingsList || settingsList.length === 0) {
      settingsList = [{
        'browserOptions': browserOptions,
        'driverOptions': driverOptions
      }];
    }
    settingsList.forEach(function(settings) {
      config.scripts.forEach(function(pathToGlob) {
        glob.sync(pathToGlob).forEach(function(path) {
          if (S(path).endsWith('.json')) {
            parseJSONFile(path, testRuns, silencePrints, listenerFactory, exeFactory, settings.browserOptions, settings.driverOptions, listenerOptions, dataSources);
          }
        });
      });
    });
  });
}

/** Parses a suite JSON file and adds the resulting TestRuns to testRuns. */
function parseSuiteFile(path, fileContents, testRuns, silencePrints, listenerFactory, exeFactory, browserOptions, driverOptions, listenerOptions, dataSources) {
  fileContents.scripts.forEach(function(scriptLocation) {
    if (scriptLocation.where != "local") {
      console.error('Suite members stored using ' + scriptLocation.where + ' are not supported.');
      return null;
    }
    var relPath = pathLib.join(path, '..', scriptLocation.path);
    var tr = null;
    if (fs.existsSync(relPath)) {
      parseScriptFile(relPath, null, testRuns, silencePrints, listenerFactory, exeFactory, browserOptions, driverOptions, listenerOptions, dataSources);
    } else {
      parseScriptFile(scriptLocation.path, null, testRuns, silencePrints, listenerFactory, exeFactory, browserOptions, driverOptions, listenerOptions, dataSources);
    }
  });
}

/** Parses script JSON and adds the resulting runs to the testRuns list. */
function parseScriptFile(path, data, testRuns, silencePrints, listenerFactory, exeFactory, browserOptions, driverOptions, listenerOptions, dataSources) {
  if (!data) {
    var rawData = fs.readFileSync(path, "UTF-8");
    data = JSON.parse(subEnvVars(rawData));
  }
  var script = data;
  var name = path.replace(/.*\/|\\/, "").replace(/\.json$/, '');
  var dataRows = [{}];
  if (script.data) {
    dataRows = loadData(script.data, dataSources, path);
  }
  var rowName = 1;
  dataRows.forEach(function(row) {
    var runName = name;
    if (dataRows.length > 1) {
      runName += ", row " + rowName;
      rowName++;
    }
    var tr = new TestRun(script, runName, row);
    tr.browserOptions = browserOptions || tr.browserOptions;
    tr.driverOptions = driverOptions || tr.driverOptions;
    tr.silencePrints = silencePrints;
    tr.listener = listenerFactory(tr, listenerOptions);
    if (exeFactory) {
      tr.executorFactories.splice(0, 0, exeFactory);
    }
    testRuns.push(tr);
  });
}

/** Loads a script JSON file and turns it into a test run. Retained for backwards compatibility. */
function createTestRun(path, silencePrints, listenerFactory, exeFactory, browserOptions, driverOptions, listenerOptions) {
  var script = null;
  try {
    script = JSON.parse(subEnvVars(fs.readFileSync(path, "UTF-8")));
  } catch (e) {
    console.error('Unable to load ' + path + ': ' + e);
    return null;
  }
  var name = path.replace(/.*\/|\\/, "").replace(/\.json$/, '');
  tr = new TestRun(script, name);
  tr.browserOptions = browserOptions || tr.browserOptions;
  tr.driverOptions = driverOptions || tr.driverOptions;
  tr.silencePrints = silencePrints;
  tr.listener = listenerFactory(tr, listenerOptions);
  if (exeFactory) {
    tr.executorFactories.splice(0, 0, exeFactory);
  }
  return tr;
}

/** Substitutes expressions of the form ${FOO} for environment variables. */
function subEnvVars(t) {
  return t.replace(/\${([^}]+)}/g, function(match, varName) {
    return process.env[varName] === undefined ? "${" + varName + "}" : process.env[varName];
  });
}

var noneSource = {
  name: 'none',
  load: function() {
    return [{}]; // Return a single empty row.
  }
};

var manualSource = {
  name: 'manual',
  load: function(cfg) {
    return [cfg]; // Return config as a row.
  }
};

var jsonSource = {
  name: 'json',
  load: function(cfg, scriptPath) {
    var path = pathLib.resolve(cfg.path);
    if (scriptPath) {
      var relPath = pathLib.join(scriptPath, '..', cfg.path);
      if (fs.existsSync(relPath)) {
        path = relPath;
      }
    }
    var rawData = fs.readFileSync(path, "UTF-8");
    var data = JSON.parse(subEnvVars(rawData));
    return data;
  }
};

var xmlSource = {
  name: 'xml',
  load: function(cfg, scriptPath) {
    var path = pathLib.resolve(cfg.path);
    if (scriptPath) {
      var relPath = pathLib.join(scriptPath, '..', cfg.path);
      if (fs.existsSync(relPath)) {
        path = relPath;
      }
    }
    var rawData = fs.readFileSync(path, "UTF-8");
    var doc = libxml.parseXml(rawData);
    return doc.find("/testdata/test").map(function(child) {
      var row = {};
      child.attrs().forEach(function(attr) {
        row[subEnvVars(attr.name())] = subEnvVars(attr.value());
      });
      return row;
    });
  }
};

var defaultDataSources = [noneSource, manualSource, jsonSource, xmlSource];

/**
 * Given a data config and a list of data sources, loads the data rows.
 * @param dataConfig A config of the form {"source": "sourcename", "configs": {"sourcename": {cfg-data}}}
 * @param dataSources An optional list of additional data sources.
 * @param scriptPath Optionally, the path of the script we're loading data for, for use in relative paths.
 */
function loadData(dataConfig, dataSources, scriptPath) {
  if (dataSources) {
    var sources = dataSources.filter(function(ds) { return ds.name == dataConfig.source; });
    if (sources.length > 0) {
      return sources[0].load(dataConfig.configs[dataConfig.source], scriptPath);
    }
  }
  var sources = defaultDataSources.filter(function(ds) { return ds.name == dataConfig.source; });
  if (sources.length == 0) {
    throw new Error("No data source of name \"" + dataConfig.source + "\" available.");
  }
  return sources[0].load(dataConfig.configs[dataConfig.source], scriptPath);
}

exports.TestRun = TestRun;
exports.getInterpreterListener = getInterpreterListener;
exports.parseJSONFile = parseJSONFile;
exports.parseConfigFile = parseConfigFile;
exports.parseSuiteFile = parseSuiteFile;
exports.createTestRun = createTestRun;
exports.parseScriptFile = parseScriptFile;
exports.subEnvVars = subEnvVars;
exports.loadData = loadData;

// Command-line usage.
if (require.main !== module) {
  return;
}

var opt = require('optimist')
  .default('quiet', false).describe('quiet', 'no per-step output')
  .default('noPrint', false).describe('noPrint', 'no print step output')
  .default('silent', false).describe('silent', 'no non-error output')
  .default('parallel', 1).describe('parallel', 'number of tests to run in parallel')
  .describe('dataSource', 'path to data source module')
  .describe('listener', 'path to listener module')
  .describe('executorFactory', 'path to factory for extra type executors')
  .demand(1) // At least 1 script to execute.
  .usage('Usage: $0 [--option value...] [script-path...]\n\nPrefix brower options like browserName with "browser-", e.g. "--browser-browserName=firefox".\nPrefix driver options like host with "driver-", eg --driver-host=webdriver.foo.com.\nPrefix listener module options with "listener-".');

// Process arguments.
var argv = opt.argv;

var numParallelRunners = parseInt(argv.parallel, 10);

var browserOptions = { 'browserName': 'firefox' };
for (var k in argv) {
  if (S(k).startsWith('browser-')) {
    browserOptions[k.substring('browser-'.length)] = argv[k];
  }
}

var browserOptionsList = [browserOptions];
if (typeof browserOptions.browserName == 'object') {
  browserOptionsList = browserOptions.browserName.map(function(bname) {
    var bo = {};
    for (var k in browserOptions) {
      bo[k] = browserOptions[k];
    }
    bo.browserName = bname;
    return bo;
  });
}

var driverOptions = {};
for (var k in argv) {
  if (S(k).startsWith('driver-')) {
    driverOptions[k.substring('driver-'.length)] = argv[k];
  }
}

var listenerOptions = {};
for (var k in argv) {
  if (S(k).startsWith('listener-')) {
    listenerOptions[k.substring('listener-'.length)] = argv[k];
  }
}

var dataSources = [];
if (argv.dataSource) {
  var ds = [];
  if (typeof argv.dataSource == 'string') {
    ds.push(argv.dataSource);
  } else {
    ds = argv.dataSource;
  }
  ds.forEach(function(sourceName) {
    try {
      var resolved_path = pathLib.resolve(sourceName);
      dataSources.push(require(resolved_path));
    } catch (e) {
      console.error('Unable to load data source module from: "' + resolved_path + '": ' + e);
      process.exit(78);
    }
  });
}

var listener = null;
if (argv.listener) {
  try {
    var resolved_path = pathLib.resolve(argv.listener);
    listener = require(resolved_path);
  } catch (e) {
    console.error('Unable to load listener module from: "' + resolved_path + '": ' + e);
    process.exit(78);
  }
}

var listenerFactory = function() { return null; };
if (listener) {
  listenerFactory = function(tr, listenerOptions) { return listener.getInterpreterListener(tr, listenerOptions, exports); };
} else {
  if (!argv.silent && !argv.quiet) {
    listenerFactory = getInterpreterListener;
  }
}

var exeFactory = null;
if (argv.executorFactory) {
  var resolved_path = null;
  try {
    resolved_path = pathLib.resolve(argv.executorFactory);
    exeFactory = require(resolved_path);
  } catch (e) {
    console.error('Unable to load executor factory module from: "' + resolved_path + '": ' + e);
    resolved_path = null;
    process.exit(78);
  }
}

var testRuns = [];

console.log(("SE-Interpreter " + interpreter_version));

browserOptionsList.forEach(function(browserOptions) {
  argv._.forEach(function(pathToGlob) {
    glob.sync(pathToGlob).forEach(function(path) {
      if (S(path).endsWith('.json')) {
        var name = path.replace(/.*\/|\\/, "").replace(/\.json$/, "");
        var silencePrints = argv.noPrint || argv.silent;
        try {
          parseJSONFile(path, testRuns, silencePrints, listenerFactory, exeFactory, browserOptions, driverOptions, listenerOptions, dataSources);
        } catch (e) {
          console.error('Unable to load ' + path + ': ' + e);
          process.exit(65);
        }
      }
    });
  });
});

var index = -1;
var successes = 0;
var lastRunFinishedIndex = testRuns.length + numParallelRunners - 1;
function runNext() {
  index++;
  if (index < testRuns.length) {
    testRuns[index].run(function(info) {
      if (info.success) { successes++; }
      runNext();
    });
  } else {
    if (index == lastRunFinishedIndex) { // We're the last runner to complete.
      if (!argv.silent) {

        var message = successes + '/' + testRuns.length + ' tests ran successfully. Exiting';
        if (testRuns.length == 0) {
          message = 'No tests found. Exiting.'.yellow;
        } else if (successes == testRuns.length) {
          message = message.green;
        } else {
          message = message.red;
        }

        console.log(message);
      }
      process.on('exit', function() { process.exit(successes == testRuns.length ? 0 : 1); });
    }
  }
}

// Spawn as many parallel runners as desired.
for (var i = 0; i < numParallelRunners; i++) {
  runNext();
}
