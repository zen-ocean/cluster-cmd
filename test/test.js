const cluster = require('cluster');
const clc = require('./../cluster-cmd.js');
var assert; 


let inTest =  typeof global.it === 'function';
// suppress annoying output from workers
if (inTest && clc.myName != 'master')
    console.log = function () {};

function consoleLog(message) {
    // console.log('   '.repeat(indent) + message)
}


function done(err) {
}

if (inTest) {
    assert = require('assert');
}
else  {
    describe = (description, action) =>  {
        console.log(description);
        action();
    }
    it = (shoulddo, action)  => { action(done);}
    assert = (condition, message) => {
        if (message == undefined) message = '';
        if (! condition) 
            console.log(`condition not met ${message}`);
    }
    assert.equal = ((actual, expected, message) => {
        if (message == undefined) message = '';
        if (actual != expected) console.log(`assert.equal failed: `
            + `${actual} != ${expected} ${message}`)
    })
}

function registerSyncHandler(command, buggy = false) {

    function handler(args, command, workerName, timeoutMs) {
        if (buggy) throw new Error(`<<< buggy command ${command} failed >>>`)
        return args.arg
    }

    clc.on.sync(command, handler);
}

function registerAsyncHandler(command, buggy = false, delay = 0) {
    
    function handler(args, command, workerName, timeoutMs) {
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

// register for both master and workers - used in myName test
clc.on.sync('myName', () => { 
    return clc.myName;
});

clc.on.sync('shouldBeAsync', () => {
    return new Promise((resolve, reject) => {
        resolve('should be async');
    })
})

clc.on.async('shouldBeSync',() => {
    return('should be sync');
})


if (clc.myName == 'master') {
        registerSyncHandler('ms');
        registerAsyncHandler('ma');
        registerSyncHandler('msb',true);    // sync buggy
        registerAsyncHandler('mab',true);   // async buggy

        // a handler that simply reflects arguments
        function reflectHandler(args, command, workerName, timeoutMs) {
            return {command, args, workerName, timeoutMs}
        }
        clc.on.sync('mreflect', reflectHandler);
    
    describe('fork', function() {
    
        describe('fork', function() {
            it(`should return a worker with id 1`,  function() {
                try {
                    let worker = clc.fork('forktest_worker');
                    assert(worker.id == 1);
                    assert(clc.getWorkerNames().includes('forktest_worker'));
                    clc.removeWorkerName('forktest_worker');
                }
                catch(err) {
                    assert(true); // should not land here
                }
            });
        });    
    

        describe('fork: worker name must be a string', function() {
            it(`should return 'must be a string' error`,  function() {
                try {
                    clc.fork(1);
                }
                catch(err) {
                    assert(err.message.indexOf('must be a string') != -1);
                };
            });
        });

        describe('fork: master cannot be a worker name', function() {
            it(`should return ' 'master' cannot be a worker name' error`,  function() {
                try {
                    clc.fork('master');
                }
                catch(err) {
                    assert(err.message.indexOf('cannot be a worker name') != -1);
                };
            });
        });
    });
    
    describe('forkWait', function () {
   
        describe('forkWait callback', function() {
            it(`should return 'worker1' on ready`,  function(done) {
                clc.forkWait('worker1', 1500, (err, data) => {
                    assert(err == undefined && data == 'worker1');
                    done();
                });
            });
        });

        describe('forkWait promise', function() {
            it(`should return 'worker2' on 'ready'`, function(done) {
                clc.forkWait('worker2')
                .then(result => {
                    assert.equal(result, 'worker2');
                })
                done();
            });
        });

        describe('forkWait failed worker', function() {
            it(`should return error on 'failed'`, function(done) {
                clc.forkWait('failed_worker')
                .then((result) => {
                    done(new Error('An error should be returned'));
                })
                .catch(err => {

                    done();
                })
            });
        });

        describe('forkWait timeout', function() {
            it(`should time out after 2 seconds'`, function(done) {
                clc.forkWait('timedout_worker', 1000, (err, data) => {
                    assert(err && err.code == 'ETIMEDOUT');
                    clc.removeWorkerName('timedout_worker');
                    done();
                })
            });
        });
    });

    describe('on', function() {
        describe('wrong sync',  function ()  {
            it(`should be async`, function() {
                clc.run('worker1','shouldBeAsync')
                .catch(err => {
                    assert(err.message.indexOf('use on.sync') != -1)
                })
            })
        });
        describe('wrong async',  function ()  {
            it(`should be async`, function() {
                clc.run('worker1','shouldBeSync')
                .catch(err => {
                    assert(err.message.indexOf('use on.async') != -1)
                })
            })
        })
        describe('invalid arguments',  function ()  {
            it(`should return error 'invalid command`, function() {
                try {
                    clc.on.sync(1, () => {})
                }
                catch(err) {
                    let index = 
                    assert(err.message.indexOf('invalid command') != -1)
                }
            });
            it(`should return error 'invalid handler`, function() {
                try {
                    clc.on.sync('test');
                }
                catch(err) {
                    assert(err.message.indexOf('invalid handler') != -1)
                }
            });

        })
    })

    describe('send', function() {

        describe('master -> worker' , function() {

            describe('callback, sync handler', function() {
                it(`should return 1`, function(done) {
                    clc.run('worker1', 'ws', {arg: 1}, (err, data) => {
                        assert.equal(data, 1);
                        done();
                    });
                })
            });

            describe('callback, async handler', function() {
                it(`should return 2`, function(done) {
                    clc.run('worker1', 'wa', {arg: 2},(err, data) => {
                        assert.equal(data, 2);
                    });
                    done();
                })
            });

            describe('promise, sync handler', function() {
                it(`should return 3`, async function() {
                    let result = await clc.run('worker1', 'ws', {arg: 3});
                    assert.equal(result, 3);
                });
                
            });

            describe('promise, async handler', function() {
                it(`should return 4`, async function() {
                    let result = await clc.run('worker1', 'wa', {arg: 4});
                    assert.equal(result, 4);
                });
            });

            describe('callback, buggy async handler', function() {
                it(`should return error`, function(done) {
                    clc.run('worker1', 'wab', {arg: 1}, 1000, (err, data) => {
                        assert(err);
                        done();
                    });
                })
            });

            describe('callback, buggy sync handler', function() {
                it(`should return error`, function(done) {
                    clc.run('worker1', 'wsb', {arg: 1} , (err, data) => {
                        assert(err);
                        done();
                    });
                })
            });

            describe('timeout', function() {
                it(`should time out after 1000 ms`, function(done) {
                    clc.run('worker1', 'wst', {arg: 1}, 1000,  (err, data) => {
                        assert.equal(err.code, 'ETIMEDOUT');
                        done();
                    });
                })
            });

            describe('arguments', function() {

                describe('too many arguments', function() {
                    it(`should return 'too many arguments' error`, async function() {
                        try {
                            let parms = await clc.run('worker1','wreflect', 10000, 'foo' ,'baz', 'bar');
                        }
                        catch(err) {
                            assert(err.message.indexOf('too many') != -1);
                        }
                    });

                });

                describe('default args and timeoutMs', function() {
                    it(`should return args == {} and and timeoutMs == 300000`, async function() {
                        let parms = await clc.run('worker1','wreflect');
                        assert.equal(parms.timeoutMs, 300000 );
                        assert.equal(JSON.stringify(parms.args), JSON.stringify({}));
                    });

                });

                describe('default args', function() {
                    it(`should return args == {} and and timeoutMs == 300000`, async function() {
                        let parms = await clc.run('worker1','wreflect', 10000);
                        assert.equal(parms.timeoutMs, 10000 );
                        assert.equal(JSON.stringify(parms.args), JSON.stringify({}));
                    });

                });

                describe('default timeoutMs', function() {
                    it(`should return timeoutMs == 300000`, async function() {
                        let parms = await clc.run('worker1','wreflect', {arg: 1});
                        assert.equal(parms.timeoutMs, 300000 );
                        assert.equal(JSON.stringify(parms.args), JSON.stringify({arg: 1}));
                    });

                });
 
                describe('non-existing worker', function() {
                    it(`should return 'does not exist' error'`, async function() {
                        try {
                            let parms = await clc.run('nonexisting','wreflect', {arg: 1});
                        }
                        catch(err) {
                            assert(err.message.indexOf('does not exist') != -1);
                        }
                    });
                });

                describe('disconnected worker', function() {
                    it(`should return 'dead or disconnected' error'`, async function() {
                        let worker = clc.fork('disconnected_worker');
                        worker.on('disconnect', async ()  => {
                            try {
                                let parms = await clc.run('disconnected_worker','wreflect', {arg: 1});
                            }
                            catch(err) {
                                let names = clc.getWorkerNames();
                                assert(err.message.indexOf('dead or disconnected') != -1);
                                clc.removeWorkerName('disconnected_worker');
                            }
                        })
                    });
                });
            });
        });

        describe('worker -> master' , function() {
            describe('sync', function() {
                it(`should return 10`, function(done) {
                    clc.run('worker1', 'wm', {params : ['ms', {arg : 10}]},(err, result) => {
                        assert(result && result.data == 10);
                        done();
                    })
                })
            });
        
            describe('async', function() {
                it(`should return 20`, function(done) {
                    clc.run('worker1', 'wm', {params: ['ma', {arg : 20}]},(err, result) => {
                        assert(result && result.data == 20);
                        done();
                    })
                })
            });
        
            describe('callback, buggy async handler', function() {
                it(`should return error`, async function() {
                    let result = await clc.run('worker1', 'wm', {params : ['mab', {arg: 1}]});
                    assert(result.err.message.indexOf('buggy')!= -1);
                })
            });

            describe('callback, buggy sync handler', function() {
                it(`should return error`, async function() {
                    let result = await clc.run('worker1', 'wm',{params : ['msb', {arg: 1}]})
                    assert(result.err.message.indexOf('buggy')!= -1);
                })
            });

            describe('arguments', function () {

                describe('too many arguments', function() {
                    it(`should return error 'too many arguments' error`, async function() {
                        try {
                            let result = await clc.run('worker1', 'wm', {params: ['ms', 
                                {arg : 20}, 'foo','bar','baz']})
                        }
                        catch(err) {
                            assert(err.message.indexOf('too many') != -1);
                        }
                    });
                });

                describe('default args and timeoutMs', function() {
                    it(`should return args == {} and and timeoutMs == 300000`, async function() {
                        let result = await clc.run('worker1', 'wm', {params : ['mreflect']});
                        assert.equal(result.data.timeoutMs, 300000);
                        assert.equal(JSON.stringify(result.data.args), JSON.stringify({}));
                    });
                });

                describe('default args', function() {
                    it(`should return args == {}`, async function() {
                        let result = await clc.run('worker1', 'wm', {params : ['mreflect', 20000]});
                        assert.equal(result.data.timeoutMs, 20000);
                        assert.equal(JSON.stringify(result.data.args), JSON.stringify({}));
                    });
                });

                describe('default timeoutMs', function() {
                    it(`should return args == {}`, async function() {
                        let result = await clc.run('worker1', 'wm', 
                            {params : ['mreflect', {arg : 1}]});
                        assert.equal(result.data.timeoutMs, 300000);
                        assert.equal(JSON.stringify(result.data.args), JSON.stringify({arg : 1}));
                    });
                });
            });
        });

        describe('master -> master', function () {

            describe('sync', async function() {
                it(`should get result 10`, async function () {
                    let result = await clc.run('master','ms',{arg:10});
                    assert(result == 10);
                })
            });

            describe('async', async function() {
                it(`should get result 20`, async function () {
                    let result = await clc.run('master','ma',{arg:20});
                    assert(result == 20);
                })
            });
        });
    });
  
    describe('cancel', function() {

        describe('with callback', function () {
            it(`should cancel after 1000 ms`, function(done) {
                let pendingId = clc.run('worker1', 'wst', {arg: 1}, 1500,  
                    (err, data) => {
                        assert(err.code == 'ECANCELED');
                        done();
                })
                setTimeout(() => {
                    clc.cancel(pendingId)
                }, 1000);
            });
        });

        describe('with promise', function () {
            it(`should cancel after 1000 ms`, function(done) {
                let promise = clc.run('worker1', 'wst', {arg: 1}, 1500);
                let pendingId = promise.pendingId;
                promise.catch(err => {
                    assert(err.code == 'ECANCELED');
                    done();
                })
                setTimeout(() => {
                    clc.cancel(pendingId)
                }, 1000);
            });
        });

    })

    
    describe('setOptions', function() {
        describe('returns previous options', function () {
            it(`should return previous options`, function () {
                let oldOptions = clc.setOptions({defaultTimeout : 2000, maxPendingCommands: 300});
                assert.equal(JSON.stringify(oldOptions),  JSON.stringify(
                    {defaultTimeout : 300000,  maxPendingCommands : 1000}
                ))
            })
        });
        describe('sets new options', function () {
            it(`should set new options`, function () {
                clc.setOptions({defaultTimeout : 2000, maxPendingCommands: 300});
                let options = clc.setOptions();
                assert.equal(JSON.stringify(options),  JSON.stringify({defaultTimeout : 2000, 
                    maxPendingCommands: 300}));
            })
        });
        describe('invalid option', function () {
            it(`should return error 'is not a valid option`, function () {
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

  
    describe('message overflow', function () {
        it(`should return 'pending overflow' error`, function (done) {
            let oldOptions = clc.setOptions({maxPendingCommands: 5});
            Promise.all([
                clc.run('worker1', 'ws', {arg: 1}),
                clc.run('worker1', 'ws', {arg: 2}),
                clc.run('worker1', 'ws', {arg: 3}),
                clc.run('worker1', 'ws', {arg: 4}),
                clc.run('worker1', 'ws', {arg: 5})
            ])
            .then(results => {
                done();
            })
            .catch(err => {
                console.log(`---------------------------${err}`)
                assert.equal(err.message, 'pending overflow (5)');
                done();
            })
        })
    });

    describe('getWorkerByName', function () {
        it(`should return 2 (worker1 id)`, function (done) {
            let worker = clc.getWorkerByName('worker1');
            assert.equal(worker.id , 2);
            done();
        })
    });

    describe('getWorkerNames', function () {
        it(`should return ['worker1','worker2']`, function (done) {

            clc.removeWorkerName('disconnected_worker');
            clc.removeWorkerName('timedout_worker');
            clc.removeWorkerName('failed_worker');
            let names = clc.getWorkerNames();
            assert.equal(JSON.stringify(names), JSON.stringify(['worker1','worker2']));
            done();
        })
    });

    describe('removeWorkerName', function() {
        it(`should return ['worker1']`, function(done) {
            clc.removeWorkerName('disconnected_worker');
            clc.removeWorkerName('timedout_worker');
            clc.removeWorkerName('failed_worker');
            clc.removeWorkerName('worker2');
            let names = clc.getWorkerNames();
            assert.equal(JSON.stringify(names), 
               JSON.stringify(['worker1']));    
            done();
        })
    });

    describe('myName', function() {
        it(`names and workerNames should be identical`, async function() {
            clc.removeWorkerName('disconnected_worker');
            clc.removeWorkerName('timedout_worker');
            clc.removeWorkerName('failed_worker');
            clc.removeWorkerName('worker2');
            let promises = [];
            let workerNames = ['master', ...clc.getWorkerNames()]; 
            for (let workerName of workerNames)
                promises.push(clc.run(workerName,'myName'));
            let names = await Promise.all(promises);
            assert.equal(JSON.stringify(names), 
               JSON.stringify(workerNames));    
        })
    });

  




    
}
else {  // worker mode


    if (clc.myName == 'forktest_worker') {
        cluster.worker.kill();
    }
    else if (clc.myName == 'failed_worker') {
        clc.failed('failed intent');
        cluster.worker.kill();
    }
    else if (clc.myName == 'timedout_worker') {
        setTimeout(() => {
            clc.ready(clc.myName);
            cluster.worker.kill();
        }, 5000);
    }
    else if (clc.myName == 'disconnected_worker') {
        clc.ready(clc.myName);
        cluster.worker.disconnect();
    }
    else {
        registerSyncHandler('ws');
        registerAsyncHandler('wa');
        registerSyncHandler('wsb',true);
        registerAsyncHandler('wab',true);
        registerAsyncHandler('wst',false, 1500);

        // reflect arguments
        function reflectHandler(args, command, workerName, timeoutMs) {
            return {args, command, workerName, timeoutMs}
        }
        clc.on.sync('wreflect', reflectHandler);

        // master -> worker -> master
        function wmHandler(args, command, workerName) {
            return new Promise((resolve, reject) => {
                let params = args.params;
                // worker -> to master
                clc.run(...params, (err, data) => {
                    // pass data or error back to master
                    if (err) resolve({err: require('serialize-error')(err)});
                    else resolve({data})
                })
            })
        }
        clc.on.async('wm', wmHandler);
        
        clc.ready(clc.myName);
    }
 }

