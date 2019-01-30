const cluster = require('cluster');
const clc = require('./../index.js');
const assert = require('assert');
const AssertionError = require('assert').AssertionError;
const util = require('util');

// Disable mocha output  except in worker

// Disable mocha output in master

if (clc.myName != 'worker')
    console.log = function () { }; //  eslint-disable-line no-console


function registerSyncHandler(command, buggy = false) {

    function handler(args, command) {
        if (buggy) throw new Error(`<<< buggy command ${command} failed >>>`)
        return args.arg
    }

    clc.on.sync(command, handler);
}

function registerAsyncHandler(command, buggy = false, delay = 0) {

    function handler(args, command) {
        return new Promise((resolve, reject) => {
            if (buggy) reject(new Error(`<<< buggy command ${command} failed >>>`))
            else {
                if (delay == 0) resolve(args.arg);
                else setTimeout(() => {
                    resolve(args.arg);
                }, delay)
            }
        })
    }
    clc.on.async(command, handler);
}

function reflectHandler(args, command, workerName, timeoutMs) {
    return { command, args, workerName, timeoutMs }
}



//----------------------------------------- test code ----------------------------------

// register for both master and workers - used in myName test
clc.on.sync('myName', () => {
    return clc.myName;
});

clc.on.sync('shouldBeAsync', () => {
    return new Promise(resolve => {
        resolve('should be async');
    })
})

clc.on.async('shouldBeSync', () => {
    return ('should be sync');
})

//---------------------------------------- master code ---------------------------------

if (clc.myName == 'master') {

    registerSyncHandler('sync');
    registerAsyncHandler('async');
    registerSyncHandler('sync-buggy', true);    // sync buggy
    registerAsyncHandler('async-buggy', true);   // async buggy
    registerAsyncHandler('async-timeout', false, 1500);
    // a handler that simply rturns arguments
    clc.on.sync('reflect', reflectHandler);

    clc.fork('worker');
}
//---------------------------------------- worker code ---------------------------------
else if (clc.myName == 'worker') {
    describe('worker test', () => {

        after(() => {
            cluster.worker.kill();
        })

        describe('on', () => {
            describe('wrong sync', () => {
                it(`should be async`, async () => {
                    try {
                        await clc.run('shouldBeAsync');
                        assert(false, 'should throw error ERR_NOT_SYNC_HANDLER')
                    }
                    catch (err) {
                        if (err instanceof AssertionError) throw err;
                        else assert.strictEqual(err.code, 'ERR_NOT_SYNC_HANDLER')
                    }
                })
            });

            describe('wrong async', () => {
                it(`should be async`, async () => {
                    try {
                        await clc.run('shouldBeSync');
                        assert(false, 'should throw error ERR_NOT_ASYNC_HANDLER');
                    }
                    catch (err) {
                        if (err instanceof AssertionError) throw err;
                        else assert.strictEqual(err.code, 'ERR_NOT_ASYNC_HANDLER')
                    }
                })
            })

            describe('invalid arguments', () => {

                it('should return error ERR_INVALID_COMMAND', () => {
                    try {
                        clc.on.sync(1, () => { })
                        assert(false, 'should throw error ERR_INVALID_COMMAND');
                    }
                    catch (err) {
                        if (err instanceof AssertionError) throw err;
                        else assert.strictEqual(err.code, 'ERR_INVALID_COMMAND');
                    }
                });

                it('should return error ERR_INVALID_HANDLER', () => {
                    try {
                        clc.on.sync('test');
                        assert(false, `should return ERR_INVALID_HANDLER error`)
                    }
                    catch (err) {
                        if (err instanceof AssertionError) throw err;
                        else assert.strictEqual(err.code, 'ERR_INVALID_HANDLER')
                    }
                });

            })
        })

        describe('run', () => {

            describe('callback, sync handler', () => {
                it(`should return 1`, async () => {
                    assert.strictEqual(await util.promisify(clc.run)('sync', { arg: 1 }), 1);
                })
            });

            describe('callback, async handler', () => {
                it(`should return 2`, async () => {
                    assert.strictEqual(await util.promisify(clc.run)('async', { arg: 2 }), 2);
                })
            });

            describe('promise, sync handler', () => {
                it(`should return 3`, async () => {
                    let result = await clc.run('sync', { arg: 3 });
                    assert.strictEqual(result, 3);
                });

            });

            describe('promise, async handler', () => {
                it(`should return 4`, async () => {
                    let result = await clc.run('async', { arg: 4 });
                    assert.strictEqual(result, 4);
                });
            });

            describe('callback, buggy async handler', () => {
                it(`should return error`, async () => {
                    try {
                        await util.promisify(clc.run)('async-buggy', { arg: 1 });
                        assert(false, `should return 'buggy command' error`);
                    }
                    catch (err) {
                        if (err instanceof AssertionError) throw err;
                        else assert(err.message.indexOf('buggy command') != -1);
                    }
                })
            });

            describe('callback, buggy sync handler', () => {
                it(`should return error`, async () => {
                    try {
                        await util.promisify(clc.run)('sync-buggy', { arg: 1 });
                        assert(false, `should return 'buggy command' error`);
                    }
                    catch (err) {
                        if (err instanceof AssertionError) throw err;
                        else assert(err.message.indexOf('buggy command') != -1);
                    }
                })
            });

            describe('timeout', () => {
                it(`should time out after 1000 ms`, async () => {
                    try {
                        await clc.run('async-timeout', { arg: 1 }, 1000);
                        assert(false, 'should time out after 1000 ms with error ERR_COMMAND_TIMED_OUT')
                    }
                    catch (err) {
                        if (err instanceof AssertionError) throw err;
                        else assert.strictEqual(err.code, 'ERR_COMMAND_TIMED_OUT');
                    }
                })
            });

            describe('arguments', function () {

                describe('too many arguments', function () {
                    it(`should return 'too many arguments' error`, async function () {
                        try {
                            await clc.run('worker1', 'wreflect', 10000, 'foo', 'baz', 'bar');
                            assert(false, 'should return ERR_TOO_MANY_ARGUMENTS error')
                        }
                        catch (err) {
                            if (err instanceof AssertionError) throw err;
                            else assert.strictEqual(err.code, 'ERR_TOO_MANY_ARGUMENTS');
                        }
                    });
                });

                describe('default args and timeoutMs', function () {
                    it(`should return args == {} and and timeoutMs == 300000`, async function () {
                        let parms = await clc.run('reflect');
                        assert.strictEqual(parms.timeoutMs, 300000);
                        assert.strictEqual(JSON.stringify(parms.args), JSON.stringify({}));
                    });

                });

                describe('default args', function () {
                    it(`should return args == {} and and timeoutMs == 300000`, async function () {
                        let parms = await clc.run('reflect', 10000);
                        assert.strictEqual(parms.timeoutMs, 10000);
                        assert.strictEqual(JSON.stringify(parms.args), JSON.stringify({}));
                    });

                });

                describe('default timeoutMs', function () {
                    it(`should return timeoutMs == 300000`, async function () {
                        let parms = await clc.run('reflect', { arg: 1 });
                        assert.strictEqual(parms.timeoutMs, 300000);
                        assert.strictEqual(JSON.stringify(parms.args), JSON.stringify({ arg: 1 }));
                    });

                });

            });
        });

        describe('cancel', () => {

            describe('with callback', function () {
                it(`should cancel after 1000 ms with error ERR_COMMAND_CANCELED`, done => {
                    let pendingId = clc.run('async-timeout', { arg: 1 }, 1500, err => {
                        if (err) {
                            assert(err.code == 'ERR_COMMAND_CANCELED');
                            done();
                        }
                        else done(new Error('should return error ERR_COMMAND_CANCELED'))
                    })
                    setTimeout(() => {
                        clc.cancel(pendingId)
                    }, 1000);
                })
            });

            describe('with promise', function () {
                it(`should cancel after 1000 ms with error ERR_COMMAND_CANCELED`, done => {
                    var pendingId;
                    clc.run('async-timeout', { arg: 1 }, 1300)
                        .id(id => {
                            pendingId = id
                        })
                        .then(() => {
                            done(new Error('should reject with error ERR_COMMAND_CANCELED'))
                        })
                        .catch(err => {
                            try {
                                assert(err.code == 'ERR_COMMAND_CANCELED');
                                done();
                            }
                            catch (err) {
                                done(err);
                            }
                        });
                    setTimeout(() => {
                        clc.cancel(pendingId)
                    }, 1000);
                });
            });
        })

        describe('message overflow', () => {
            it(`should return error ERR_PENDING_OVERFLOW`, done => {
                clc.setOptions({ maxPendingCommands: 5 });
                Promise.all([
                    clc.run('sync', { arg: 1 }),
                    clc.run('sync', { arg: 2 }),
                    clc.run('sync', { arg: 3 }),
                    clc.run('sync', { arg: 4 }),
                    clc.run('sync', { arg: 5 }),
                    clc.run('sync', { arg: 6 }),
                ])
                    .then(() => {
                        done(new Error(`should return error ERR_PENDING_OVERFLOW`));
                    })
                    .catch(err => {
                        assert.strictEqual(err.code, 'ERR_PENDING_OVERFLOW');
                        done();
                    })
            })
        });

        describe('myName', () => {
            it(`should return 'worker`, async () => {
                assert.strictEqual(clc.myName, 'worker');
            })
        });
    })
}


