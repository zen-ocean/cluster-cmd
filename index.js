// cluster-cmd - a lightweight framework implementing the request-response 
// paradigm for cluster IPC    
// copyright 2019: zen-ocean, Stan Lomecky

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
    removeWorkerName,
    setOptions,
    getWorkerByName,
    getWorkerNames,
    myName
};

const util = require('util');
const serializeError = require('serialize-error');

const _defaultOptions = {
    forkWaitTimeout: 5000, // 5 seconds
    runTimeout: 300000,  // 5 minutes
    maxPendingCommands: 1000  // max. 1000 pending commands
};

const _errors = {
    'ERR_WORKER_TIMED_OUT': "Worker '${workerName}' timed out",
    'ERR_NO_WORKERNAME': "No worker name specified",
    'ERR_WORKERNAME_NOT_STRING': "Worker name must be a string",
    'ERR_WORKERNAME_DOESNT_EXIST': "Worker '${workerName}' does not exist",
    'ERR_WORKERNAME_EXISTS': "Worker '${workerName}' already exists",
    'ERR_WORKERNAME_MUST_NOT_BE_MASTER': "fork: 'master' cannot be a worker name",
    'ERR_WORKER_FAILED': "worker ${workerName} failed during initializaion",
    'ERR_FORKWAIT_TOO_MANY_ARGS': "too many arguments",
    'ERR_ONSYNC_OR_ONASYNC': 'please use on.sync or on.async',
    'ERR_INVALID_COMMAND': "invalid command: '${command}'",
    'ERR_INVALID_HANDLER': "invalid handler for command '${command}'",
    'ERR_WORKER_DEAD_OR_DISCONNECTED': "worker '${workerName}' is dead or disconnected",
    'ERR_TOO_MANY_ARGUMENTS': 'too many arguments',
    'ERR_COMMAND_NOT_STRING': "command is not a string: '${command}'",
    'ERR_PENDING_OVERFLOW': "pending overflow (${value})",
    'ERR_COMMAND_TIMED_OUT': "command ${command} timed out",
    'ERR_COMMAND_CANCELED': "command canceled",
    'ERR_NOT_SYNC_HANDLER': "Handler for command ${command}' returns a Promise"
        + " - use on.async",
    'ERR_NOT_ASYNC_HANDLER': "Handler for command ${command}' doesn't return "
        + "a Promise - use on.sync",
    'ERR_INVALID_OPTION': "'${option}' is not a valid option",
}

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
    const { err } = _isValidWorkerName(workerName);
    if (err) throw err;
    if (env == undefined) env = {};
    env._workerName = workerName; // used by 'myName' function
    var worker = cluster.fork(env);
    worker._workerName = workerName;
    // establish 'message' listener for new worker
    worker.on('message', message => {
        if (message._ready) _processReadyMessage(message);
        if (message._request) _processRequest(message, worker);
        else if (message._reply) _processReply(message);
    });

    _workers.set(workerName, worker);
    return worker;
}

//------------------------- forkWait ---------------------------------------

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
        if (rest.length > 3) return { err: _err(forkWait, 'ERR_FORKWAIT_TOO_MANY_ARGS') };
        let env, timeoutMs, callback;
        // determina arguments by type
        for (let param of rest) {
            if (typeof param == 'object') env = param;
            else if (typeof param == 'number') timeoutMs = param;
            else if (typeof param == 'function') callback = param;
        }

        if (env == undefined) env = {};
        if (timeoutMs == undefined) timeoutMs = _options.forkWaitTimeout;

        return { workerName, env, timeoutMs, callback }
    }

    if (cluster.isMaster) { // forkWait only works in master
        let { err, workerName, env, timeoutMs, callback } = getParameters();
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
        fork(workerName, env);
    }
    catch (err) { // probably invalid workerName
        callback(err);
        return;
    }
    if (timeoutMs > 0) { // create and store timer
        let timer = setTimeout(() => {
            _readyHandlers.delete(workerName); // remove handler info
            callback(_err(forkWait, 'ERR_WORKER_TIMED_OUT', { workerName }, 'ETIMEDOUT'));
        },
        timeoutMs);
        // store info to be used on 'ready' or 'failed' from worker
        _readyHandlers.set(workerName, { callback, timer });
    }
    else _readyHandlers.set(workerName, { callback }); // no timer
}

//------------------------- on -----------------------------------------

// registers a command handler for a command 
// Handler can be async (returning promise) or sync (returning data).
// Command name '*' specifies default handler.
// on.sync should be used to register sync handlers and
// on.async to regiser async handlers
function on() {
    throw _err(on, 'ERR_ONSYNC_OR_ONASYNC');
}

on.sync = _onSync;
on.async = _onAsync;

function _onSync(command, handler) {
    if (cluster.isWorker && !_workerInitialized)
        _wInitialize();
    if (typeof command != 'string' || !command)
        throw _err('on.sync', 'ERR_INVALID_COMMAND', { command });
    if (typeof handler != 'function')
        throw _err('on.sync', 'ERR_INVALID_HANDLER', { command });
    _commandHandlers[command] = { handler, type: 's' };
}

function _onAsync(command, handler) {
    if (cluster.isWorker && !_workerInitialized)
        _wInitialize();
    if (typeof command != 'string' || !command)
        throw _err('on.async', 'ERR_INVALID_COMMAND', { command });
    if (typeof handler != 'function')
        throw _err('on.async', 'ERR_INVALID_HANDLER', { command });

    // store handler and sync/async info to be used by _processRequest
    _commandHandlers[command] = { handler, type: 'a' };
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
    return cluster.isMaster ? _mRun(...params) : _wRun(...params);
}

// run command,  internal master-to-worker version
// if timeoutMs is omitted, the default timeout value is used
// if no callback is provided, a promise is returned
// parameters: workerName, command [,args] [,timeoutMs] [,callback]
function _mRun(...params) {

    function getParameters() {
        let [workerName, command, ...rest] = params;
        if (rest.length > 3)
            return { err: _err(run, 'ERR_TOO_MANY_ARGUMENTS') };
        let args, timeoutMs, callback;
        // determine parameters by type
        for (const param of rest) {
            if (typeof param == 'object') args = param;
            else if (typeof param == 'number') timeoutMs = param;
            else if (typeof param == 'function') callback = param;
        }

        if (args == undefined) args = {};
        if (timeoutMs == undefined) timeoutMs = _options.runTimeout;

        if (typeof workerName != 'string')
            return { err: _err(run, 'ERR_WORKERNAME_NOT_STRING', { workerName }) };
        if (typeof command != 'string')
            return { err: _err(run, 'ERR_COMMAND_NOT_STRING', { command }) };

        return { workerName, command, args, timeoutMs, callback }
    }

    let { err, workerName, command, args, timeoutMs, callback }
        = getParameters();
    if (err) throw err; // invalid parameters 
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
        // Add 'id' property for command id access
        promise.id = func => {
            func(pendingId);
            return promise
        };
        return promise;
    }
}

// run: internal  master-to-worker callback version
// returns pendingId which can be used to cancel command
function _mRunCallback(workerName, command, args, timeoutMs, callback) {

    // special case: master can send a command to itself bypassig IPC
    function sendToMyself() {
        let { handler, type } = _getHandler(command);
        if (handler == undefined) callback(_err(run, 'ERR_INVALID_COMMAND', { command }))
        else {
            if (type == 's') { // sync handler (returns data)
                try {
                    callback(null, handler(args, command, 'master', timeoutMs));
                }
                catch (err) {
                    callback(err); // Error in handler
                }
            }
            else { // async handler (returns a promise)
                handler(args, command, 'master', timeoutMs)
                    .then(data => {
                        callback(null, data);
                    })
                    .catch(err => {
                        callback(err); // Error in handler
                    })
            }
        }
    }

    if (workerName == 'master') sendToMyself();  // master -> master
    else { // sending to a worker
        let worker = getWorkerByName(workerName);
        if (worker == undefined)
            callback(_err(run, 'ERR_WORKERNAME_DOESNT_EXIST', { workerName }));
        else if (worker.isDead() || !worker.isConnected())
            callback(_err(run, 'ERR_WORKER_DEAD_OR_DISCONNECTED', { workerName }));
        else {
            try {
                let pendingId = _createPendingEntry(command, callback, timeoutMs);
                // send request to worker
                worker.send({
                    _request: true, _pendingId: pendingId, _workerName: workerName,
                    _command: command, _args: args, _timeoutMs: timeoutMs
                })
                return pendingId;  // to be used by 'cancel' 
            }
            catch (err) {
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
        let [command, ...rest] = params; // only command required
        if (rest.length > 3)
            return { err: _err(run, 'ERR_TOO_MANY_ARGUMENTS') };
        let args, timeoutMs, callback;

        // determine parameters by type
        for (const param of rest) {
            if (typeof param == 'object') args = param;
            else if (typeof param == 'number') timeoutMs = param;
            else if (typeof param == 'function') callback = param;
        }

        if (args == undefined) args = {};
        if (timeoutMs == undefined) timeoutMs = _options.runTimeout;

        if (typeof command != 'string')
            return { err: _err(run, 'ERR_COMMAND_NOT_STRING', { command }) };

        return { command, args, timeoutMs, callback }
    }

    // make sure worker message handler is registered
    if (!_workerInitialized) _wInitialize();

    let { err, command, args, timeoutMs, callback } = getParameters();
    if (err) throw err;
    if (callback != undefined) // callback version
        return _wRunCallback(command, args, timeoutMs, callback)
    else {
        let pendingId;
        let promise = new Promise((resolve, reject) => {
            pendingId = _wRunCallback(command, args, timeoutMs, (err, data) => {
                if (err) reject(err);
                else resolve(data);
            });
        })
         // Add 'id' property for command id access
        promise.id = func => {
            func(pendingId);
            return promise
        };
        return promise;
    }
}

// run: internal  worker-to-master callback version
// returns pendingId which can be used to cancel command
function _wRunCallback(command, args, timeoutMs, callback) {
    try {
        let pendingId = _createPendingEntry(command, callback, timeoutMs);
        process.send({
            _request: true, _pendingId: pendingId, _command: command,
            _args: args, _workerName: myName, _timeoutMs: timeoutMs
        })
        return pendingId;
    }
    catch (err) {
        callback(err); // probably maxPendingCommands exceeded
    }
}

// helper functions
// creates an entry in the _pending map with command callback and 
// timer information
function _createPendingEntry(command, callback, timeoutMs) {
    if (_options.maxPendingCommands > 0 && _pending.size >=
        _options.maxPendingCommands)
        throw _err(run, 'ERR_PENDING_OVERFLOW');
    var pendingId = _createUniqueId();
    if (timeoutMs == undefined) timeoutMs = _options.runTimeout;
    var msg = { callback, timeoutMs };
    if (timeoutMs > 0) { // 0 for no timer
        msg.timer = setTimeout(() => {
            _pending.delete(pendingId); // timer will cancel command
            callback(_err(run, 'ERR_COMMAND_TIMED_OUT', { command }, 'ETIMEDOUT'));
        },
            timeoutMs);
    }
    // store in map of pending commands
    _pending.set(pendingId, msg);  // 
    return pendingId;
}

// retrieves handler and its type ('s'for sync or 'a' for async) 
// from _commandHandlers
function _getHandler(command) {
    let info = _commandHandlers[command]; // handler for this command?
    if (info == undefined) info = _commandHandlers['*']; // default handler?
    if (info == undefined) return { handler: undefined, type: undefined }
    else return info;
}

//-------------------------  ready --------------------------------------------

// sends 'ready' message to master indicating that
// worker is ready to receive commands.
// <data> is passed back to 'forkWait' function
function ready(data) {
    if (cluster.isWorker) // only works in worker
        process.send({ _ready: true, _workerName: myName, _data: data })
}

//-------------------------  failed -------------------------------------------

// sends 'failed' message to master indicating that
// initialization failed and worker therefore cannot receive commands
// forkWait will fail with 'err'
function failed(err) {
    if (cluster.isWorker) { // only works in worker
        if (!err) 
            err = _err(forkWait, 'ERR_WORKER_FAILED', {workerName: myName()});
        process.send({ _ready: true, _workerName: myName, _err: _serializeError(err) })
    }
}

//-------------------------  cancel ------------------------------------------

// cancels a command previously sent to master or worker
// takes as parameter 'pendingId' returned by 'run' function
// Command is terminated with error code 'ERR_COMMAND_CANCELED'.
// If a timer was set for this command, it is cleared
function cancel(pendingId) {
    let info = _pending.get(pendingId);
    if (info != undefined) { // command has not yet been executed
        if (info.timer) clearTimeout(info.timer);
        _pending.delete(pendingId); // remove pending command entry
        // let command fail with error.code ERR_COMMAND_CANCELED 
        info.callback(_err(run, 'ERR_COMMAND_CANCELED', {}, 'ECANCELED')); 
    }
}

//-------------------------  setOptions--------------------------------

// Sets the default timeout interval for the functions 'run' and 'forkWait'
// a value of 0 disables timeouts, i.e. the user is resposible for cancelling
// any hanging command (by using the 'cancel' function) - not recommended
function setOptions(options) {
    if (options == undefined) options = {};
    let previous = Object.assign({}, _options); // shallow copy
    for (let option in options) {
        if (_defaultOptions.hasOwnProperty(option))
            _options[option] = options[option];
        else throw _err(setOptions, 'ERR_INVALID_OPTION', { option })
    }
    return previous; // return options before change
}

//-------------------------  removeWorkerName------------------------------

// Removes entry 'workerName' from list of active workers
// It is the user's responsibility to terminate the worker 
function removeWorkerName(workerName) {
    return _workers.delete(workerName);
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
    return [..._workers.keys()];
}

//--------------------------- message handlers -------------------------

// processes 'ready' or 'failed' message from worker
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
    let { _pendingId: pendingId, _err: err, _data: data } = message;
    let info = _pending.get(pendingId); // retrieve callback info
    if (info != undefined) {
        let { callback, timer } = info;
        _pending.delete(pendingId);
        if (timer)
            clearTimeout(timer); // clear existing timer
        if (err) callback(_deserializeError(err));
        else callback(null, data);
    }
}

// processes request to master or worker:
// retrieves handler, executes it and sends reply back 
// to worker or master
// parameters: message, worker (in master mode)
// parameter: message (in worker mode)
function _processRequest(message, worker) {

    function send(reply) {
        if (worker) worker.send(reply); // master mode
        else process.send(reply)  // worker mode
    }

    function processSyncHandler(handler) {
        try {
            let data = handler(message._args, message._command,
                message._workerName, message._timeoutMs);
            // data should not be a Promise, wrong registration as sync
            if (data != undefined && typeof data.then == 'function') {
                reply._err = _serializeError(_err(on, 'ERR_NOT_SYNC_HANDLER',
                    { command: message._command }));
                send(reply);
            }
            else {
                reply._data = data;
                send(reply);
            }
        }
        catch (e) { // handler error, serialize it and send back to caller
            if (e == undefined) reply._err = '_undefined'; // otherwise it will not be sent
            else reply._err = _serializeError(e);
            send(reply)
        }
    }

    function processAsyncHandler(handler) {
        try {
            handler(message._args, message._command, message._workerName,
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
        catch (err) {
            // check whether handler returned a promise
            if (err.name == 'TypeError' &&
                err.message.indexOf('.then') != -1)
                reply._err = _serializeError(_err(on, 'ERR_NOT_ASYNC_HANDLER',
                    { command: message._command }))
            // handler error, serialize it and send back to caller        
            else reply._err = _serializeError(err);  
            send(reply);
        }
    }

    var { _request, _args, ...reply } = message; //  eslint-disable-line no-unused-vars
    reply._reply = true;
    let { handler, type } = _getHandler([message._command]);
    if (handler == undefined) { // unregistered command
        reply._err = _serializeError(_err(run, 'ERR_INVALID_COMMAND', { command: message._command }));
        send(reply);
    }
    else {
        if (type == 's') processSyncHandler(handler);
        else processAsyncHandler(handler);
    }
}

//-------------------------  utilities ---------------------------------

// generates unique id (currently timestamp) for storing command callbacks 
function _createUniqueId() {
    let t = process.hrtime(); // use timestamp
    return t[0].toString() + '-' + t[1].toString();
}

// takes an Error object and
// returns a JSON.stringifiable object
function _serializeError(data) {
    if (data instanceof Error) {
        let obj = serializeError(data);
        if (data instanceof RangeError) obj._errorType = 'RangeError';
        else if (data instanceof ReferenceError) obj._errorType = 'ReferenceError';
        else if (data instanceof SyntaxError) obj._errorType = 'SyntaxError';
        else if (data instanceof TypeError) obj._errorType = 'TypeError';
        else if (data instanceof URIError) obj._errorType = 'URIError';
        else obj._errorType = 'Error';
        return obj;
    }
    else return data;
}

// reverses _serializeError
function _deserializeError(data) {
    if (typeof data == 'object' && data._errorType) {
        let error = data._errorType == 'RangeError' ? new RangeError() :
            data._errorType == 'ReferenceError' ? new ReferenceError() :
                data._errorType == 'SyntaxError' ? new SyntaxError() :
                    data._errorType == 'TypeError' ? new TypeError() :
                        data._errorType == 'URIError' ? new URIError() :
                            new Error();
        delete data._errorType;
        delete data.name;
        error.stack = '';
        Object.assign(error, data);
        return error;
    }
    else return data;
}

// checks validity of worker name
function _isValidWorkerName(workerName) {
    if (typeof workerName == 'undefined' || workerName == null)
        return { err: _err(fork, 'ERR_NO_WORKERNAME', { workerName }) };
    if (typeof workerName != 'string')
        return { err: _err(fork, 'ERR_WORKERNAME_NOT_STRING', { workerName }) };
    if (_workers.has(workerName))
        return { err: _err(fork, 'ERR_WORKERNAME_EXISTS', { workerName }) };
    if (workerName == 'master')  // 'master' reserved for master process 
        return { err: _err(fork, 'ERR_WORKERNAME_MUST_NOT_BE_MASTER', { workerName }) };
    return {}; // no error
}

// All errors defined in '_errors' are generated by this function
function _err(func, code, parms = {}, errName = 'Error') {
    if (typeof func == 'function') func = func.name;
    let { workerName, command, option } = parms;
    if (!_errors.hasOwnProperty(code))
        throw new Error(`${code} is not a valid error code`);
    let message = func ? func + ':' : '';
    message += _errors[code].replace(/\${workerName}/g, workerName)
        .replace(/\${command}/g, command)
        .replace(/\${option}/g, option)
    let error = new Error(message);
    error.code = code;
    error.name = errName;
    return error;
}

