const cluster = require('cluster');
const clc = require('cluster-cmd');
const assert = require('assert');
const AssertionError = require('assert').AssertionError;
const util = require('util');


// Disable mocha output in workers

if (clc.myName != 'master') 
    console.log = function () {}; //  eslint-disable-line no-console


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
    return {command, args, workerName, timeoutMs}
}

function createWorker(workerName) {
    if (clc.getWorkerByName(workerName) == undefined )
        return clc.forkWait(workerName);
    else return Promise.resolve(workerName);
}      


function killAllWorkers() {

    function killWorker(worker) {
        return new Promise(resolve => {
            if (worker.isConnected()) {
                worker.on('exit', () => {
                    resolve(true);
                })
                worker.kill();
            }
            else resolve(false);
        })
    }

    let promises = [];
    for (const workerName of clc.getWorkerNames()) {
        promises.push(killWorker(clc.getWorkerByName(workerName)));
        clc.removeWorkerName(workerName);
    }
    return Promise.all(promises);
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

clc.on.async('shouldBeSync',() => {
    return('should be sync');
})

registerSyncHandler('sync');
registerAsyncHandler('async');

//---------------------------------------- master code ---------------------------------

if (clc.myName == 'master') {

    describe('master test' , () => {
        after(async () => {
            await killAllWorkers();
        })

        describe('fork', () => {

            after(async () => {
                await killAllWorkers();
            })
    
            it(`should return a worker with id 1`, async () => {
                let worker = clc.fork('forktest_worker');
                assert.strictEqual(worker._workerName,  'forktest_worker');
            })
    
            it(`should throw error ERR_WORKERNAME_NOT_STRING`, ()  => {
                try {
                    clc.fork(1);
                    assert(false, 'should throw error ERR_WORKERNAME_NOT_STRING')
                }
                catch(err) {
                    assert.strictEqual(err.code, 'ERR_WORKERNAME_NOT_STRING');
                }
            })
    
            it(`should throw error ERR_WORKERNAME_MUST_NOT_BE_MASTER`, ()  => {
                try {
                    clc.fork('master');
                    assert(false, 'should throw error ERR_WORKERNAME_MUST_NOT_BE_MASTER')
                }
                catch(err) {
                    assert.strictEqual(err.code, 'ERR_WORKERNAME_MUST_NOT_BE_MASTER');
                }
            })
        });

        describe('forkWait',  () => {

            after(async () => {
                await killAllWorkers();
            })

            describe('callback', () => {
                it(`should return 'worker'`, async ()  => {
                    let reply = await util.promisify(clc.forkWait)('worker');
                    assert.strictEqual(reply, 'worker');
                })
            })

            describe('promise', () =>  {
                it(`should return 'worker2'`, async  ()  => {
                    let workerName = await clc.forkWait('worker2');
                    assert.strictEqual( workerName, 'worker2');
                })
            })

            describe('failed worker', function() {
                it(`should return error 'failed intentionally'`, async  ()  => {
                    try {
                        await clc.forkWait('failed_worker');
                        assert(false, 'should reject')
                    }
                    catch(err) {
                        if (err instanceof AssertionError) throw err;
                        else assert.strictEqual(err, 'failed intentionally')
                    }
                })
            })

            describe('timeout', () => {
                it(`should return ERR_WORKER_TIMED_OUT error`, async  ()  => {
                    try {
                        await clc.forkWait('timedout_worker', 1000)
                        assert(false, 'should throw ERR_WORKER_TIMED_OUT error')
                    }
                    catch(err) {
                        if (err instanceof AssertionError) throw err;
                        else assert.strictEqual(err.code, 'ERR_WORKER_TIMED_OUT');
                    } 
                })
            });     
        });

        describe('on', () => {

            before(async () => {
                await createWorker('worker');
            })

            describe('wrong sync',  () =>  {
                it(`should be async`, async () => {
                    try {
                        await clc.run('worker','shouldBeAsync');
                        assert(false, 'should throw error ERR_NOT_SYNC_HANDLER')
                    }
                    catch(err) {
                        if (err instanceof AssertionError) throw err;
                        else assert.strictEqual(err.code, 'ERR_NOT_SYNC_HANDLER')
                    }
                })
            });

            describe('wrong async',  () =>  {
                it(`should be async`, async () => {
                    try {
                        await clc.run('worker','shouldBeSync');
                        assert(false, 'should throw error ERR_NOT_ASYNC_HANDLER');
                    }
                    catch(err) {
                        if (err instanceof AssertionError) throw err;
                        else assert.strictEqual(err.code, 'ERR_NOT_ASYNC_HANDLER')
                    }
                })
            })

            describe('invalid arguments',  () =>  {

                it('should return error ERR_INVALID_COMMAND', () => {
                    try {
                        clc.on.sync(1, () => {})
                        assert(false, 'should throw error ERR_INVALID_COMMAND');
                    }
                    catch(err) {
                        if (err instanceof AssertionError) throw err;
                        else assert.strictEqual(err.code, 'ERR_INVALID_COMMAND');
                    }
                });

                it('should return error ERR_INVALID_HANDLER', () => {
                    try {
                        clc.on.sync('test');
                        assert(false, `should return ERR_INVALID_HANDLER error`)
                    }
                    catch(err) {
                        if (err instanceof AssertionError) throw err;
                        else assert.strictEqual(err.code, 'ERR_INVALID_HANDLER')
                    }
                });

            })
        })

        describe('run', () => {

            before(async () => {
                await createWorker('worker');
            })

            describe('callback, sync handler', () => {
                it(`should return 1`, async () => {
                    assert.strictEqual(await util.promisify(clc.run)('worker', 'sync', {arg: 1}) , 1);
                })
            });

            describe('callback, async handler', () => {
                it(`should return 2`, async () => {
                    assert.strictEqual(await util.promisify(clc.run)('worker', 'async', {arg: 2}) , 2);
                })
            });

            describe('promise, sync handler', ()  => {
                it(`should return 3`, async () => {
                    let result = await clc.run('worker', 'sync', {arg: 3});
                    assert.strictEqual(result, 3);
                });
                
            });

            describe('promise, async handler', () => {
                it(`should return 4`, async ()  => {
                    let result = await clc.run('worker', 'async', {arg: 4});
                    assert.strictEqual(result, 4);
                });
            });

            describe('callback, buggy async handler', () => {
                it(`should return error`,  async () => {
                    try {
                        await util.promisify(clc.run)('worker', 'async-buggy', {arg: 1});
                        assert(false, `should return 'buggy command' error`);
                    }
                    catch(err) {
                        if (err instanceof AssertionError) throw err;
                        else assert(err.message.indexOf('buggy command') != -1);
                    }
                })
            });

            describe('callback, buggy sync handler', () => {
                it(`should return error`, async () => {
                    try {
                        await util.promisify(clc.run)('worker', 'sync-buggy', {arg: 1});
                        assert(false, `should return 'buggy command' error`);
                    }
                    catch(err) {
                        if (err instanceof AssertionError) throw err;
                        else assert(err.message.indexOf('buggy command') != -1);
                    }
                })
            });

            describe('timeout', () => {
                it(`should time out after 1000 ms`, async () => {
                    try {
                        await clc.run('worker', 'async-timeout', {arg: 1}, 1000);
                        assert(false, 'should time out after 1000 ms with error ERR_COMMAND_TIMED_OUT')
                    }
                    catch(err) {
                        if (err instanceof AssertionError) throw err;
                        else assert.strictEqual(err.code, 'ERR_COMMAND_TIMED_OUT');
                    }
                })
            });

            describe('arguments', function() {

                describe('too many arguments', function() {
                    it(`should return 'too many arguments' error`, async function() {
                        try {
                            await clc.run('worker','reflect', 10000, 'foo' ,'baz', 'bar');
                            assert(false, 'should return ERR_TOO_MANY_ARGUMENTS error')
                        }
                        catch(err) {
                            if (err instanceof AssertionError) throw err;
                            else assert.strictEqual(err.code, 'ERR_TOO_MANY_ARGUMENTS');
                        }
                    });
                });

                describe('default args and timeoutMs', function() {
                    it(`should return args == {} and and timeoutMs == 300000`, async function() {
                        let parms = await clc.run('worker','reflect');
                        assert.strictEqual(parms.timeoutMs, 300000 );
                        assert.strictEqual(JSON.stringify(parms.args), JSON.stringify({}));
                    });

                });

                describe('default args', function() {
                    it(`should return args == {} and and timeoutMs == 300000`, async function() {
                        let parms = await clc.run('worker','reflect', 10000);
                        assert.strictEqual(parms.timeoutMs, 10000 );
                        assert.strictEqual(JSON.stringify(parms.args), JSON.stringify({}));
                    });

                });

                describe('default timeoutMs', function() {
                    it(`should return timeoutMs == 300000`, async function() {
                        let parms = await clc.run('worker','reflect', {arg: 1});
                        assert.strictEqual(parms.timeoutMs, 300000 );
                        assert.strictEqual(JSON.stringify(parms.args), JSON.stringify({arg: 1}));
                    });

                });

                describe('non-existing worker', function() {
                    it(`should return 'does not exist' error'`, async function() {
                        try {
                            await clc.run('nonexisting','reflect', {arg: 1});
                            assert(false, 'should return ERR_WORKERNAME_DOESNT_EXIST error')
                        }
                        catch(err) {
                            if (err instanceof AssertionError) throw err;
                            assert.strictEqual(err.code, 'ERR_WORKERNAME_DOESNT_EXIST');
                        }
                    });
                });

                describe('disconnected worker', function() {
                    it(`should return 'dead or disconnected' error'`, async function() {
                        let worker = clc.fork('disconnected_worker');
                        worker.on('disconnect', async ()  => {
                            try {
                                await clc.run('disconnected_worker','reflect', {arg: 1});
                                assert(false,' should throw ERR_WORKER_DEAD_OR_DISCONNECTED error')
                            }
                            catch(err) {
                                assert(err.code, 'ERR_WORKER_DEAD_OR_DISCONNECTED');
                            }
                        })
                    });
                });
            });
        });
            
        describe('run master -> master', () => {

            describe('sync', async function() {
                it(`should get result 10`, async function () {
                    let result = await clc.run('master','sync',{arg:10});
                    assert(result == 10);
                })
            });

            describe('async', async function() {
                it(`should get result 20`, async function () {
                    let result = await clc.run('master','async',{arg:20});
                    assert(result == 20);
                })
            });
        });


        describe('cancel', ()  => {

            before(async () => {
                await createWorker('worker');
            })

            describe('with callback', function () {
                it(`should cancel after 1000 ms with error ERR_COMMAND_CANCELED`, done => {
                    let pendingId = clc.run('worker', 'async-timeout', {arg: 1}, 1300, err => {
                        if (err) {
                            assert(err.code == 'ERR_COMMAND_CANCELED');
                            done();
                        }
                        else  done(new Error('should return error ERR_COMMAND_CANCELED'))
                    })
                    setTimeout(() => {
                        clc.cancel(pendingId)
                    }, 1000);
                })
            });

            describe('with promise', function () {
                it(`should cancel after 1000 ms with error ERR_COMMAND_CANCELED`, done => {
                    var pendingId;
                    clc.run('worker', 'async-timeout', {arg: 1}, 1300)
                    .id(id => {
                        pendingId = id
                    })
                    .then(() => {
                        done(new Error('should reject with error ERR_COMMAND_CANCELED'))
                    })
                    .catch(err => {
                        try {
                            assert.strictEqual(err.code, 'ERR_COMMAND_CANCELED');
                            done();
                        }
                        catch(err) {
                            done(err);
                        }
                    });
                    setTimeout(() => {
                        clc.cancel(pendingId)
                    }, 1000);
                });
            });
        })

        describe('setOptions', () => {

            describe('returns previous options', () => {
                it(`should return previous options`, ()  => {
                    let oldOptions = clc.setOptions({runTimeout : 2000, maxPendingCommands: 300});
                    assert.strictEqual(JSON.stringify(oldOptions),  JSON.stringify(
                        {forkWaitTimeout: 5000, runTimeout : 300000,  maxPendingCommands : 1000}
                    ))
                })
            });

            describe('sets new options', () => {
                it(`should set new options`, () => {
                    clc.setOptions({forkWaitTimeout: 1000, runTimeout : 2000, 
                        maxPendingCommands: 300});
                    let options = clc.setOptions();
                    assert.strictEqual(JSON.stringify(options), JSON.stringify({forkWaitTimeout: 1000, 
                        runTimeout : 2000, maxPendingCommands: 300}));
                })
            });

            describe('invalid option', () => {
                it(`should return error 'is not a valid option`, () => {
                    try {
                        clc.setOptions({buggy : 2000, maxPendingCommands: 300});
                        assert(false, 'should throw error');
                    }
                    catch(err) {
                        assert(err.message.indexOf('is not a valid option') != -1);
                    }
                })
            });
        })
    
        describe('message overflow',  () => {

            before(async () => {
                await createWorker('worker');
            })

            it(`should return error ERR_PENDING_OVERFLOW`, function (done) {
                clc.setOptions({maxPendingCommands: 5});
                Promise.all([
                    clc.run('worker', 'sync', {arg: 1}),
                    clc.run('worker', 'sync', {arg: 2}),
                    clc.run('worker', 'sync', {arg: 3}),
                    clc.run('worker', 'sync', {arg: 4}),
                    clc.run('worker', 'sync', {arg: 5}),
                    clc.run('worker', 'sync', {arg: 6}),
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

        describe('workerNames', () => {
            
            before(async () => {
                await killAllWorkers();
                await Promise.all([
                    createWorker('worker1'),
                    createWorker('worker2'),
                    createWorker('worker3')
                ])
            })

            describe('getWorkerByName', () => {
                it(`should return 2 (worker1 id)`, function (done) {
                    let worker = clc.getWorkerByName('worker1');
                    assert.strictEqual(worker._workerName, 'worker1');
                    done();
                })
            });

            describe('getWorkerNames', () => {
                it(`should return ['worker1','worker2','worker3]`, () => {
                    let names = clc.getWorkerNames();
                    assert.strictEqual(JSON.stringify(names), 
                        JSON.stringify(['worker1','worker2','worker3']));
                })
            });
        })

        describe('myName', async () => {
            before( async () => {
                await createWorker('worker1')
            })
            it(`should be name == 'worker1'`, async () => {
                let name = await clc.run('worker1','myName');
                assert.strictEqual(name, 'worker1')
            })
        });
    })
}

//---------------------------------------- worker code ---------------------------------
else {  // worker mode
    if (clc.myName == 'worker') {
 
        registerSyncHandler('sync-buggy',true);
        registerAsyncHandler('async-buggy',true);
        registerAsyncHandler('async-timeout',false, 1500); 

        // reflect arguments
        
        clc.on.sync('reflect', reflectHandler);
        clc.ready(clc.myName);
    }
    else if (['worker1', 'worker2', 'worker3'].includes(clc.myName)) {
        clc.ready(clc.myName);
    }
    else if (clc.myName == 'failed_worker') {
        clc.failed('failed intentionally');
    }
    else if (clc.myName == 'timedout_worker') {
        setTimeout(() => {
            clc.ready(clc.myName);
        }, 5000);
    }
    else if (clc.myName == 'disconnected_worker') {
        clc.ready(clc.myName);
        cluster.worker.disconnect();
    }
 }
