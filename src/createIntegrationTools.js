/*
 * PHPTest - Test helper library for PHP core runtime components
 * Copyright (c) Dan Phillimore (asmblah)
 * https://github.com/uniter/phptest/
 *
 * Released under the MIT license
 * https://github.com/uniter/phptest/raw/master/MIT-LICENSE.txt
 */

'use strict';

var _ = require('microdash'),
    escapeRegex = require('regexp.escape'),
    path = require('path'),
    mochaPath = path.dirname(require.resolve('mocha/package.json')),
    phpToAST = require('phptoast'),
    phpToJS = require('phptojs'),
    util = require('util'),
    SourceMapConsumer = require('source-map').SourceMapConsumer,
    WeakMap = require('es6-weak-map');

/**
 * Creates an integration test helper tools object.
 *
 * @param {string} phpCorePath
 * @param {Function=} initRuntime
 * @param {boolean=} forceOpcodesAsync
 * @returns {Object}
 */
module.exports = function (phpCorePath, initRuntime, forceOpcodesAsync) {
    var
        resolvedPHPCorePath = path.resolve(phpCorePath),
        OpcodeExecutor = require(resolvedPHPCorePath + '/src/Core/Opcode/Handler/OpcodeExecutor'),
        Reference = require(resolvedPHPCorePath + '/src/Reference/Reference'),
        Value = require(resolvedPHPCorePath + '/src/Value').sync(),
        Variable = require(resolvedPHPCorePath + '/src/Variable').sync(),
        runtimeFactory = require(resolvedPHPCorePath + '/src/shared/runtimeFactory'),

        // A map that allows looking up the source map data for a module later on.
        moduleDataMap = new WeakMap(),

        /**
         * Creates a Runtime with the given mode.
         *
         * @param {string} mode
         * @returns {Runtime}
         */
        createRuntime = function (mode) {
            var runtime = runtimeFactory.create(mode);

            return initRuntime ? initRuntime(runtime) : runtime;
        },

        createAsyncRuntime = function () {
            // Create an isolated runtime we can install builtins into without affecting the main singleton one.
            return createRuntime('async');
        },
        createPsyncRuntime = function () {
            // Create an isolated runtime we can install builtins into without affecting the main singleton one.
            return createRuntime('psync');
        },
        createSyncRuntime = function () {
            // Create an isolated runtime we can install builtins into without affecting the main singleton one.
            return createRuntime('sync');
        },

        transpile = function (path, php, phpCore, options) {
            var transpiledResult,
                module,
                phpParser,
                phpToJSBaseOptions;

            options = options || {};
            path = path || null;

            phpParser = phpToAST.create(null, _.extend({
                // Capture offsets of all nodes for line tracking
                captureAllBounds: true
            }, options.phpToAST));

            if (path) {
                phpParser.getState().setPath(path);
            }

            phpToJSBaseOptions = {
                // Record line numbers for statements/expressions
                lineNumbers: true,

                path: path,

                prefix: 'return '
            };

            if (options.sourceMap) {
                // Generate a source map if specified in test options
                _.extend(phpToJSBaseOptions, {
                    sourceMap: {
                        sourceContent: php,
                        returnMap: true
                    }
                });
            }

            transpiledResult = phpToJS.transpile(
                phpParser.parse(php),
                _.extend(phpToJSBaseOptions, options.phpToJS),
                options.transpiler
            );

            module = new Function('require', options.sourceMap ? transpiledResult.code : transpiledResult)(function () {
                return phpCore;
            });

            // Note that we do not support setting additional module options for PHPCore,
            // because module-level options are deprecated in favour of environment-level ones.
            if (path !== null) {
                module = module.using({
                    path: path
                });
            }

            if (options.sourceMap) {
                // Allow source map data to be looked up later (see .normaliseStack(...))
                moduleDataMap.set(module, {sourceMapGenerator: transpiledResult.map, path: path});
            }

            return module;
        },

        /**
         * Forces all opcodes to be async for all async mode tests, to help ensure async handling is in place.
         *
         * @param {Runtime} runtime
         */
        installForcedAsyncOpcodeHook = function (runtime) {
            runtime.install({
                serviceGroups: [
                    function (internals) {
                        var get = internals.getServiceFetcher();

                        // As we'll be overriding the "opcode_executor" service.
                        internals.allowServiceOverride();

                        return {
                            'opcode_executor': function () {
                                var controlBridge = get('control_bridge'),
                                    futureFactory = get('future_factory'),
                                    referenceFactory = get('reference_factory'),
                                    valueFactory = get('value_factory');

                                function AsyncOpcodeExecutor() {
                                }

                                util.inherits(AsyncOpcodeExecutor, OpcodeExecutor);

                                AsyncOpcodeExecutor.prototype.execute = function (opcode) {
                                    var result = opcode.handle();

                                    if (!opcode.isTraced()) {
                                        // Don't attempt to make any untraced opcodes pause,
                                        // as resuming from inside them is not possible.
                                        return result;
                                    }

                                    if (controlBridge.isFuture(result) && result.isSettled()) {
                                        // Wrap settled Futures in a deferring one to force a pause.
                                        return futureFactory.createAsyncPresent(result);
                                    }

                                    if (result instanceof Value) {
                                        return valueFactory.createAsyncPresent(result);
                                    }

                                    if (result instanceof Reference || result instanceof Variable) {
                                        return referenceFactory.createAccessor(function () {
                                            // Defer returning the value of the reference.
                                            return valueFactory.createAsyncPresent(result.getValue());
                                        }, function (value) {
                                            // Defer assignment in a microtask to test for async handling.
                                            return valueFactory.createAsyncMicrotaskFuture(function (resolve, reject) {
                                                result.setValue(value).next(resolve, reject);
                                            });
                                        }, function () {
                                            return futureFactory.createAsyncPresent(result.unset());
                                        }, function () {
                                            return result.getReference();
                                        }, function (reference) {
                                            result.setReference(reference);
                                        }, function () {
                                            result.clearReference();
                                        }, function () {
                                            return result.isDefined();
                                        }, function () {
                                            return result.isReadable();
                                        }, function () {
                                            return futureFactory.createAsyncPresent(result.isEmpty());
                                        }, function () {
                                            return futureFactory.createAsyncPresent(result.isSet());
                                        }, function () {
                                            return result.isReference();
                                        }, function () {
                                            return futureFactory.createAsyncPresent(result.raiseUndefined());
                                        });
                                    }

                                    return result;
                                };

                                return new AsyncOpcodeExecutor();
                            }
                        };
                    }
                ]
            });
        },

        // Create isolated runtimes to be shared by all tests that don't create their own,
        // to avoid modifying the singleton module exports.
        asyncRuntime = createAsyncRuntime(),
        psyncRuntime = createPsyncRuntime(),
        syncRuntime = createSyncRuntime(),

        // Errors from a Function constructor-created function may be offset by the function signature
        // (currently 2), so we need to calculate this in order to adjust for source mapping below
        // (Note that the unused "require" arg is given so that the signature matches the Function(...) eval above)
        errorStackLineOffset = new Function(
            'require',
            'return new Error().stack;'
        )()
            .match(/<anonymous>:(\d+):\d+/)[1] - 1;

    if (forceOpcodesAsync !== false) {
        installForcedAsyncOpcodeHook(asyncRuntime);
    }

    return {
        asyncRuntime: asyncRuntime,
        psyncRuntime: psyncRuntime,
        syncRuntime: syncRuntime,

        createAsyncEnvironment: function (options, addons) {
            return asyncRuntime.createEnvironment(options, addons);
        },

        createAsyncRuntime: createAsyncRuntime,

        createPsyncEnvironment: function (options, addons) {
            return psyncRuntime.createEnvironment(options, addons);
        },

        createPsyncRuntime: createPsyncRuntime,

        createSyncEnvironment: function (options, addons) {
            return syncRuntime.createEnvironment(options, addons);
        },

        createSyncRuntime: createSyncRuntime,

        installForcedAsyncOpcodeHook: installForcedAsyncOpcodeHook,

        /**
         * Attempts to make this integration test slightly less brittle when future changes occur,
         * by scrubbing out things that are out of our control and likely to change (such as line/column numbers
         * of stack frames within Mocha) and performs source mapping of the stack frame file/line/column
         *
         * @param {string} stack
         * @param {Function} module
         * @return {Promise<string>}
         */
        normaliseStack: function (stack, module) {
            var moduleData;

            if (!moduleDataMap.has(module)) {
                throw new Error(
                    'Test harness error: module data map does not contain data for this module - ' +
                    'did you forget to set options.sourceMap?'
                );
            }

            moduleData = moduleDataMap.get(module);

            return new SourceMapConsumer(moduleData.sourceMapGenerator/*, sourceMapUrl */)
                .then(function (sourceMapConsumer) {
                    stack = stack.replace(
                        // Find stack frames for the transpiled PHP code - source maps would not be handled natively
                        // even if we embedded them in the generated JS, so we need to perform manual mapping
                        /\(eval at transpile \(.*\/phptest\/src\/createIntegrationTools\.js:\d+:\d+\), <anonymous>:(\d+):(\d+)\)/g,
                        function (all, line, column) {
                            var mappedPosition = sourceMapConsumer.originalPositionFor({
                                // Note: These number casts are required, the source-map library
                                //       will otherwise fail to resolve any mappings
                                line: line - errorStackLineOffset,
                                column: column * 1
                            });

                            if (mappedPosition.line === null && mappedPosition.column === null) {
                                // Unless something has gone wrong, we should be able to map all generated JS frames back to PHP
                                throw new Error('Stack line in evaluated PHP code could not be mapped back to PHP source');
                            }

                            return '(' + mappedPosition.source + ':' + mappedPosition.line + ':' + mappedPosition.column + ')';
                        }
                    );

                    // Normalise Mocha frames
                    stack = stack.replace(new RegExp('^(.*)' + escapeRegex(mochaPath) + '(.*:)\\d+:\\d+', 'gm'), '$1/path/to/mocha$2??:??');
                    // Group Mocha frames (to allow for differences between versions)
                    stack = stack.replace(/(?:(?:.*\/path\/to\/mocha.*)([\r\n]*))+/mg, '    at [Mocha internals]$1');

                    // Normalise Node.js internal frames
                    stack = stack.replace(/^(?:([^/(]+?\()([^/]+?)\.js|(.*?)(?:node:)?internal\/(.*?)(?:\.js)?):\d+:\d+/gm, '$1$3/path/to/internal/$2$4:??:??');
                    // Group Node.js internal frames (to allow for differences between versions)
                    stack = stack.replace(/(?:(?:.*\/path\/to\/internal.*)([\r\n]*))+/mg, '    at [Node.js internals]$1');

                    // Normalise PHPCore frames
                    stack = stack.replace(new RegExp(escapeRegex(resolvedPHPCorePath), 'g'), '/path/to/phpcore');

                    return stack;
                });
        },

        asyncTranspile: function (path, php, options) {
            return transpile(path, php, asyncRuntime, options);
        },

        psyncTranspile: function (path, php, options) {
            return transpile(path, php, psyncRuntime, options);
        },

        syncTranspile: function (path, php, options) {
            return transpile(path, php, syncRuntime, options);
        },

        transpile: function (runtime, path, php, options) {
            return transpile(path, php, runtime, options);
        }
    };
};
