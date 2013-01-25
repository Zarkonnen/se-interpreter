se-interpreter
==============

This is a command-line tool for interpreting [Selenium Builder](http://www.sebuilder.com) JSON script files, based on [node](http://nodejs.org/) and the [wd](https://github.com/admc/wd) Javascript client driver for [Selenium 2](http://seleniumhq.org/). It aims to have the same functionality as its [Java-based counterpart](https://github.com/sebuilder/se-builder/wiki/Se-Interpreter).

You can supply scripts to the interpreter and have them played back on a Selenium server. You can also import the interpreter as a npm dependency and use it as a library, attaching listeners to get detailed information at each state of the playback process, and controlling the step-by-step execution.

There is also a syntax for config files that let you specify a set of script runs.

se-interpreter is currently under development. It is not yet available through npm. It's being developed by [David Stark](mailto:david.stark@zarkonnen.com) at the behest of [Sauce Labs](http://saucelabs.com/), and licensed under the Apache License, Version 2.0:

    Copyright 2013 Sauce Labs

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.