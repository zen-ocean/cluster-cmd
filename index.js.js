// cluster-cmd - a lightweight framework implementing the request-response 
// paradigm for cluster IPC    
// copyright 2018-2019: Stan Lomecky

const cluster = require('cluster');
const myName = cluster.isMaster ? 'master' : process.env._workerName;

module.exports = {
    fork,
    forkWait,
    on,
    run,
    ready,
    failed,
    cancel,
    setOptions,
    getWorkerByName,
    getWorkerNames,
    removeWorkerName,
    myName
};

const util = require('util');
const serializeError = require('serialize-error');

const _defaultOptions = {
    defaultTimeout : 300000,  // 5 minutes
    maxPendingCommands : 1000  // max. 1000 pending commands
};  

var _options = _defaultOptions;
var _pending = new Map(); // maps pending command id to callback information
var _workers = new Map(); // maps name to cluster.worker
var _commandHandlers = {}; // maps command to handler
var _readyHandlers = new Map(); // maps worker to 'ready' handler
var _workerInitialized = false; // true after '_wInitialize' has been called

//------------------------- fork ---------------------------------------

// starts new worker worker and stores it under <workerName>
// does nothing when in worker mode
// <env> plus _workerName is added to environment variables of new worker
// parameters: workerName [,env]
function fork(workerName, env) {
    const [nameOk, errorMsg] = _isValidWorkerName(workerName);
    if (! nameOk ) throw new Error(errorMsg);
    if (env == undefined) env = {};
    env._workerName = workerName; // used by 'myName' function
    var worker = cluster.fork(env);
    _workers.set(workerName, worker);
    return worker;
}
 
// starts (forks) worker with the specified name and waits for 
// 'ready' message from worker (which the worker triggers by calling 
// the 'ready' function.
// If 'timeoutMs' is specified, the functions throws a ETIMEDOUT
// error after <timeoutMs> milliseconds.  If 'timeOutMs' is not specified, 
// the default interval is used (5 min). A 'timeoutMs' of 0 does
// not create a timer (not recommended, as mast process may hang)
// If no 'callback' is specified, the function returns a Promise.
// parameters: workerName [,env] [,timeoutMs] [,callback]
function forkWait(...params) {

    function getParameters() { 
        let [workerName, ...rest] = params;
        if (rest.length > 3) return {err: 'forkWait: too many arguments'};
        let env, timeoutMs, callback;
        for (param of rest) {
            if (typeof param == 'object') env = param;
            else if (typeof param == 'number') timeoutMs = param;
            else if (typeof param == 'function') callback = param;
        }

        if (env == undefined) env = {};
        if (timeoutMs == undefined) timeoutMs =  _options.defaultTimeout;

        if (typeof workerName != 'string')
            return {err : `forkWait: worker name must be a string`};

        return {workerName, env, timeoutMs, callback}
    }

    if (cluster.isMaster) {
        let {err, workerName, env, timeoutMs, callback} = getParameters();
        if (err) throw err; // invalid parameters
        if (callback != undefined) // callback provided
            _forkWaitCallback(workerName, env, timeoutMs, callback);
        else  // promise version
            return util.promisify(_forkWaitCallback)(workerName, env, timeoutMs);
    }
}

// internal callback version
function _forkWaitCallback(workerName, env, timeoutMs, callback) {
    try {
        var worker = fork(workerName, env);
    }
    catch(err) { // probably invalid workerName
        callback(err);
        return;
    }
    // establish 'message' listener for new worker
    worker.on('message', message => { 
        if (message._ready) _processReadyMessage(message);
        if (message._request) _processRequest(message, worker);  
        else if (message._reply) _processReply(message);
    });
    if (timeoutMs > 0) { // create and store timer
        let timer = setTimeout(() => {
            _readyHandlers.delete(workerName); // remove handler info
            let error = new Error(`worker ${workerName}: timed out`);
            error.name = error.code = 'ETIMEDOUT';
            callback(error);
        }, 
        timeoutMs);
        _readyHandlers.set(workerName, {callback, timer});
    }
    else  _readyHandlers.set(workerName, {callback}); // no timer
}
    
//------------------------- on -----------------------------------------
    
// registers a command handler for a command 
// Handler can be async (returning promise) or sync (returning data).
// Command name '*' specifies default handler.
// on.sync should be used to register sync handlers and
// on.async to regiser async handlers
function on(command, handler) {
    throw new Error('Please use on.sync or on.async');
}

on.sync = _onSync;
on.async = _onAsync;

function _onSync(command, handler) {
    if (cluster.isWorker && ! _workerInitialized)
        _wInitialize();
    if (typeof command != 'string' || ! command)
        throw new Error(`on.sync: invalid command: '${command}'`);
    if (typeof handler != 'function')
        throw new Error(`on.sync: invalid handler for command '${command}'`);
    _commandHandlers[command] = { handler, type: 's'};
}

function _onAsync(command, handler) {
    if (cluster.isWorker && ! _workerInitialized)
        _wInitialize();
    if (typeof command != 'string' || ! command)
        throw new Error(`on.async: invalid command: '${command}'`);
    if (typeof handler != 'function')
        throw new Error(`on.async: invalid handler for command '${command}'`);

    _commandHandlers[command] = { handler, type: 'a'};
}

// registers 'message' listener for worker
function _wInitialize() {
    process.on('message', message => { 
        if (message._request) _processRequest(message);  // request from master
        else if (message._reply) _processReply(message); // reply from master
    });
    _workerInitialized = true;
}

//------------------------- run ----------------------------------------------

// sends a command to worker (if cluster.isMaster) 
// or to master (if cluster.isWorker)
// if <callback> is specified a message id is returned which can be
// if no callback is provided, a promise is returned
// used to cancel the command (see function 'cancel')
// parameters: workerName, command [,args] [,timeoutMs] [,callback]   (if master)
// parameters: command [,args] [,timeoutMs] [,callback]   (if worker)
function run(...params) {
    return cluster.isMaster ? _mRun(...params) :  _wRun(...params);
}

// run command,  internal master-to-worker version
// if timeoutMs is omitted, the default timeout value is used
// if no callback is provided, a promise is returned
// parameters: workerName, command ,args] [,timeoutMs] [,callback]
function _mRun(...params) {

    function getParameters() { 
        let [workerName, command, ...rest] = params;
        if (rest.length > 3) 
            return {err : 'run: too many arguments'};
        let args, timeoutMs, callback;
        // determine parameters by type
        for (param of rest) {
            if (typeof param == 'object') args = param;
            else if (typeof param == 'number') timeoutMs = param;
            else if (typeof param == 'function') callback = param;
        }

        if (args == undefined) args = {};
        if (timeoutMs == undefined) timeoutMs =  _options.defaultTimeout;

        if (typeof workerName != 'string') 
            return({err : `run: worker name is not a string: ${workerName}`});
        if (typeof command != 'string') 
            return {err : `run: command is not a string: ${command}`};

        return {workerName, command, args, timeoutMs, callback}
    }

    let {err, workerName, command, args, timeoutMs, callback} 
        = getParameters();
    if (err) throw new Error(err); // invalid parameters 
    if (callback != undefined) // callback provided
        return _mRunCallback(workerName, command, args, timeoutMs, callback)
    else {
        let pendingId;
        let promise = new Promise((resolve, reject) => {
            pendingId = _mRunCallback(workerName, command, args, timeoutMs, (err, data) => {
                if (err) reject(err);
                else resolve(data);
            });
        })
        promise.pendingId = pendingId; // used by 'cancel' function
        return promise;
    }
}

// run: internal  master-to-worker callback version
// returns pendingId which can be used to cancel command
function _mRunCallback(workerName, command, args, timeoutMs, callback) {
    
    // special case: master can send a command to itself bypassig IPC
    // This is useful, when master and workers handle idntical commands
    function sendToMyself() {
        let {handler, type} = _getHandler(command); 
        if (handler == undefined) callback(new Error(`Invalid command: ${command}`))
        else {
            if (type == 's') { // sync handler (returns data)
                try {
                    let result = handler(args, command, 'master');
                    callback(null, result);
                }
                catch(e) {
                    callback(e); // Error in handler
                }
            }
            else { // async handler (returns a promise)
                handler(args, command, 'master')
                .then(data => {
                    callback(null, data);
                })
                .catch(err => {
                    callback(err); // Error in handler
                })
            }
        }
    }

    if (workerName == 'master')  sendToMyself();  // master -> master
    else { // sending to a worker
        worker = getWorkerByName(workerName);
        if (worker == undefined) 
            callback(new Error(`Worker with name '${workerName}' does not exist`));
        else if (worker.isDead() || ! worker.isConnected())           
            callback(new Error(`Worker ${workerName} is dead or disconnected`));
        else {
            try {
                let pendingId =_createPendingEntry(command, callback, timeoutMs); 
                worker.send({_request: true, _pendingId: pendingId, _workerName : workerName,
                    _command: command, _args: args, _timeoutMs : timeoutMs})
                return pendingId;  // used by 'cancel' 
            }
            catch(err) {
                callback(err);  // probably maxPendingCommands exceeded
            }
        }
    }
}

// / run command,  worker-to-master version
// if timeoutMs is omitted, the default timeout value is used
// if no callback is provided, a promise is expected
// parameters: command [,args] [,timeoutMs] [,callback]
function _wRun(...params) {

    function getParameters() { // determine parameters by type
        let [command, ...rest] = params;
        if (rest.length > 3) 
            return {err :'run: too many arguments'};
        let args, timeoutMs, callback;
         // determine parameters by type
        for (param of rest) {
            if (typeof param == 'object') args = param;
            else if (typeof param == 'number') timeoutMs = param;
            else if (typeof param == 'function') callback = param;
        }

        if (args == undefined) args = {};
        if (timeoutMs == undefined) timeoutMs =  _options.defaultTimeout;

        if (typeof command != 'string') 
            return {err : `run: command is not a string: ${command}`};

        return {command, args, timeoutMs, callback}
    }

    // make sure worker message handler is registered
    if ( ! _workerInitialized) _wInitialize(); 

    let {err, command, args, timeoutMs, callback} = getParameters();
    if (err) throw new Error(err);
    if (callback != undefined) // callback 
        return _wRunCallback(command, args, timeoutMs, callback)
    else {
        let pendingId;
        let promise = new Promise((resolve, reject) => {
            pendingId = _wRunCallback(command, args, timeoutMs, (err, data) => {
                if (err) reject(err);
                else resolve(data);
            });
        })
        promise.pendingId = pendingId;
        return promise;
    }
}

// run: internal  worker-to-master callback version
// returns pendingId which can be used to cancel command
function _wRunCallback(command, args, timeoutMs, callback) {
    try {
        let pendingId =_createPendingEntry(command, callback, timeoutMs);
        process.send({_request: true, _pendingId: pendingId, _command: command, 
            _args: args, _workerName : myName, _timeoutMs: timeoutMs})
        return pendingId;
    }
    catch(err) {
        callback(err); // message map overflow
    }
}

// helper functions
// creates an entry in the _pending map with callback and timer information
function _createPendingEntry(command, callback, timeoutMs) {
    if (_options.maxPendingCommands > 0 && _pending.size >= 
        _options.maxPendingCommands)
        throw new Error(`pending overflow (${_options.maxPendingCommands})`);
    var pendingId = _createUniqueId();
    if (timeoutMs == undefined) timeoutMs = _options.defaultTimeout;
    var msg = {callback, timeoutMs};
    if (timeoutMs > 0) { // 0 for no timer
        msg.timer = setTimeout(() => {
            _pending.delete(pendingId); // timer will cancel command
            let error = new Error(`Command ${command} timed out`);
            error.name = error.code = 'ETIMEDOUT';
            callback(error);
        }, 
        timeoutMs);
    }
    _pending.set(pendingId, msg);  // 
    return pendingId;
}
// retrieves handler and its type ('s'for sync or 'a' for async) 
// from _commandHandlers
function _getHandler(command) {
    let info = _commandHandlers[command]; // handler for this command?
    if (info == undefined)  info = _commandHandlers['*']; // default handler?
    if (info == undefined) return {handler : undefined, type: undefined}
    else return info;
}
 

//-------------------------  ready --------------------------------------------

// sends 'ready' message to master indicating that
// worker is ready to receive commands.
// <data> is passed back to 'forkWait' function
//parameters: [data]
function ready(data) { 
    if (cluster.isWorker) // do nothing if master
        process.send({_ready: true, _workerName : myName, _data: data})
} 

//-------------------------  failed -------------------------------------------

// Sends 'failed' message to master indicating that
// initialization failed and worker therefore cannot receive commands
// forkWait will fail with 'err'
// parameter: err
function failed(err) {
    if (! err) err = new Error();
    if (cluster.isWorker) // do nothing if master
        process.send({_ready: true , _workerName : myName, _err: _serializeError(err)})
} 

//-------------------------  cancel ------------------------------------------

// cancels a command previously sent to master or worker
// takes as parameter 'pendingId' returned by 'run' function
// Command is terminated with error code 'ECANCELED'
// If a timer was set for this command, it is cleared
function cancel(pendingId) {
    let info = _pending.get(pendingId);
    if (info  != undefined) { // command has not yet been executed
        if (info.timer) 
            clearTimeout(info.timer);
        let err = new Error('command canceled');
        err.name = err.code = 'ECANCELED';
        _pending.delete(pendingId); // remove pending command
        info.callback(err); // send ECANCELED error back to caller
    }
}

//-------------------------  setOptions--------------------------------

// Sets the default timeout interval for the functions 'run' and 'forkWait'
// a value of 0 disables timeouts, i.e. the user is resposible for cancelling
// any hanging command (by using the 'cancel' function) - not recommended
//parameter: timeoutMs: new default timeout interval in milliseconds
function setOptions(options) {
    if (options == undefined) options = {};
    let previous = Object.assign({}, _options); // shallow copy
    for (option in options) {
        if (_defaultOptions.hasOwnProperty(option))
            _options[option] = options[option];
        else throw new Error(`'${option}' is not a valid option`);
    }
    return previous; // return options before change
}


//-------------------------  getWorkerByName ---------------------------------

// get worker object with specified name
// returns undefined if worker does not exist
//parameter: workerName
function getWorkerByName(workerName) {
    return _workers.get(workerName);
}

//-------------------------  getWorkerNames ---------------------------------

// returns array of worker names
function getWorkerNames() {
    return [ ..._workers.keys() ];
}

//-------------------------  removeWorkerName --------------------------

// removes worker from map of worker names
// user is responsible to disconnect/kill the worker
// returns true iff worker existed
// does not allow for workerName to be removed if
// worker is still active
// parameter: workerName

function removeWorkerName(workerName) {
    return _workers.delete(workerName);
}

//--------------------------- message handlers -------------------------

// processes 'ready' message from worker
// retrieves and calls  callback function stored in '_readyHandlers' 
// parameter: message: message passed from worker
function _processReadyMessage(message) {
    // retrieve stored 'ready' callback function
    let info = _readyHandlers.get(message._workerName);
    if (info != undefined) { // not yet timed out
        _readyHandlers.delete(message._workerName);
        if (info.timer)
            clearTimeout(info.timer);
        if (message.hasOwnProperty('_err')) // worker called 'failed(err)'
            info.callback(_deserializeError(message._err));
        else 
            info.callback(null, message._data); // worker called 'ready(data)'
    }
}

// processes reply from master or server:
// retrieves and calls  callback function stored in '_pending' 
function _processReply(message) {  
    let {_pendingId : pendingId, _err : err, _data : data} = message;
    let info = _pending.get(pendingId); // retrieve callback info
    if (info != undefined) { 
        let {callback, timer} = info;
        _pending.delete(pendingId);
        if (timer ) 
            clearTimeout(timer); // clear existing timer
        if (err) callback(_deserializeError(err)); 
        else  callback(null, data); 
    }
}

// processes request to master or worker:
// retrieves handler, executes it and sends reply back 
// to worker or master
// parameters: message, worker (in master mode)
// parameter: message (in worker mode)
function _processRequest(message, worker)  {

    function send(reply) {
        if (worker) worker.send(reply); // master mode
        else  process.send(reply)  // worker mode
    }

    function processSyncHandler(handler) {
        try {
            let data = handler(message._args, message._command, 
                message._workerName, message._timeoutMs);
            // data should not be a Promise, wrong registration as sync
            if (data != undefined && typeof data.then == 'function')  {
                reply._err = _serializeError(
                    new Error(`${message._command} returns Promise - use on.async`));
                send(reply);
            }
            else {
                reply._data = data;
                send(reply);    
            }  
        }
        catch(e) {
            if (e == undefined) e = '_undefined'; // otherwise it will not be sent
            reply._err = _serializeError(e);
            send(reply)
        }
    }

    function processAsyncHandler(handler) {
        try { 
            let promise = handler(message._args, message._command, message._workerName,
                message._timeoutMs)
            .then(data => {
                reply._data = data;
                send(reply);
            })
            .catch(err => {
                reply._err = _serializeError(err);
                send(reply);
            })
        }
        catch(err) {
            if (err.name == 'TypeError' && err.message.indexOf('.then is not a function')) {
                err = new Error(`Handler for '${message._command}' does not return a promise - use on.sync`);
            }
            reply._err = _serializeError(err);
            send(reply);
        }
    }

    var {_request, _args, ...reply } = message; // remove _request and _args
    reply._reply = true;
    let {handler, type} = _getHandler([message._command]); 
    if (handler == undefined) {
        reply._err = _serializeError(new Error(`Invalid command: ${message._command}`));
        send(reply);
    }
    else {
        if (type == 's') processSyncHandler(handler);
        else processAsyncHandler(handler);
    }

}

// Send error <err> to all pending commands 
function _cancelPendingCommands(err) {
    for (let [pendingId, info] of _pending) {
        info.callback(err);
        _pending.clear();
    }

}

//-------------------------  utilities ---------------------------------

// generates unique id for requests (timestamp)
function _createUniqueId() { 
    let t = process.hrtime(); // use timestamp
    return t[0].toString() + '-' + t[1].toString();
}

// takes an Error object and
// returns a JSON.stringifiable object
function _serializeError(err) {
    return serializeError(err); 
}

// reverses _serializeError
function _deserializeError(errObj) {
    let error = new Error(errObj.message);
    error.stack = '';
    if (typeof errObj == 'object') Object.assign(error, errObj);
    return error;
}

// checks validity of worker name
function _isValidWorkerName(workerName) {
    if (typeof workerName == 'undefined' || workerName == null)
        return [false, `No worker name specified`];
    if (typeof workerName != 'string')
        return [false, `Worker name must be a string`];    
    if (_workers.has(workerName)) 
        return [false, `Worker ${workerName} already exists`];
    if (workerName == 'master')  // 'master' reserved for master process 
        return [false, `'master' cannot be a worker name`];
    return [true]; // no error
}
