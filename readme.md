# cluster-cmd

**cluster-cmd** is a small framework implementing the command-response paradigm for the Cluster module. Instead of concentrating inter-process comunication (ipc)  logic into the ```worker.on``` and ```process.on``` event handlers, you can  call a function in another thread pretty much the same way  you would call a local function.

Main features:

  - transparent to the Node.js cluster module
  - master-to-worker and worker-to-master commands
  - basic master-worker synchronization
  - timeout handling


# How it works

Synchronous or asynchronous command handlers are registered using the ```on.sync```
or ```on.async``` functions, respectively.
These commands can then be executed remotely using the ```run```  function.

Step 1:  Require cluster-cmd:
````javascript
const clc = require('cluster-cmd')
````

Step 2: As master, start a new worker without waiting for it to start up ...
````javascript
clc.fork('worker')
````
... or start it and wait until it has replied with 'ready' or 'failed' message:
````javascript
clc.forkWait('worker')
.then(() => {
    console.log('worker is ready')
})
.catch(err => {
    console.log(`worker initialization failed: ${err}`);
})
````

Step 3: Register your command handlers, either sync ...
````javascript
clc.on.sync('add', ([a,b]) => {  
    	return a + b;
});
````

... or async: 
````javascript
clc.on.async('async_add', ([a,b]) => {  
    return new Promise(resolve => {
        setTimeout(() => {
            resolve(a + b);
        }, 2000)
    })
})
````
Step 4: Inside master code, run the command - previously registered in a worker - with async/await syntax : 
````javascript
let sum = await clc.run('worker', 'add', [3,4]);
// very much like the local version: let sum = add([3,4])
````
... or with promise syntax:
````javascript
clc.run('worker', 'add', [3,4])
.then(sum => {
    ...
})
.catch(err => {
    ...
})
````
... or with good old callback syntax:
````javascript
clc.run('worker', 'add', [3,4], (err, sum) => {
    if (err)  ...
    else ....
})

````
Inside worker code, run the command 'add' registered by master:
````javascript
let sum = await clc.run('add', [3,4])

````
The promise and callback variants work analogously.

See below for a <a href="#example">full working example</a>.


# Exports
* <a href="#fork">fork</a>
* <a href="#forkwait">forkWait</a>
* <a href="#on">on</a>
* <a href="#run">run</a>
* <a href="#ready">ready</a>
* <a href="#failed">failed</a>
* <a href="#cancel">cancel</a>
* <a href="#setoptions">setOptions</a>
* <a href="#removeworkername">removeWorkerName</a>
* <a href="#getworkerbyname">getWorkerByName</a>
* <a href="#getworkernames">getWorkerNames</a>
* <a href="#myname">myName</a>


<h2 id="fork">fork (workerName [,env])</h2>

* ````workerName````: string  
* ````env````: object

This function starts a new worker with the specified name. The worker name serves as a reference to the worker.  ````getWorkerByName(workerName)````  gets you the underlying cluster.worker object. ````getNames()```` returns an array of all worker names.

````env```` is an object whose properties will be added to the worker's ````process.env```` object. Default is { }. ````fork```` always adds the property ````'_workerName'````(holding the worker's name) to the worker's environment.

````fork```` can produce the following errors (error.code):
* ERR_NO_WORKERNAME : missing worker name 
* ERR_WORKERNAME_NOT_STRING : worker name is not a string
* ERR_WORKERNAME_EXISTS: a worker with the same name already exists
* ERR_WORKERNAME_MUST_NOT_BE_MASTER: 'master' is not allowed as worker name


<h2 id="forkwait">forkWait(workerName [,env] [, timeoutMs] [, callback])</h2>

* ````workerName````: string  
* ````timeoutMs```` : number
*  ````env````: object

This function calls ````fork(workerName, env)```` , then waits until the worker has called the ````ready```` function. A timeout interval can be specified with ````timeoutMs````.

Example:
````javascript
Promise.all[
    forkWait('server1', 6000, {port:8080}),
    forkWait('server2', 6000, {port:8081}),
    forkWait('server3', 6000, {port:8082})
]
.then(() => {
    console.log('All three workers running and initialized');
})

// process.env.port will be available in all workers 

````
````forkWait```` can produce the same errors as ````fork```` plus:
* ERR_FORK_TOO_MANY_ARGS: too many arguments
* ERR_WORKER_TIMED_OUT: worker did not call ````ready```` within ````timeoutMs```` milliseconds
* ERR_WORKER_FAILED: worker called ````failed````



<h2 id="on">on</h2

You cannot call ```on``` directly but have to use ````on.sync```` or  ````on.async````. If you call ```on``` directly, you will get the ERR_ONSYNC_OR_ONASYNC error.

## on.sync(command, handler)


* ````command````: string  
* ````handler````: function (arguments, command, workerName, timeoutMs)

This function registers a sync command handler, i.e. a function returning a value. It can be used both in master and worker mode. A special case is  ```` command == '*'```` which registers a default command handler (used when no specific command handler exists).

If you mistakenly register an async function with ````on.sync````, you will get the ERR_NOT_SYNC_HANDLER error at the next ````run````  .

````on.async```` can produce the following errors (error.code):

* ERR_INVALID_COMMAND: ````command```` is undefined or not a string
* ERR_INVALID_HANDLER: ````command```` is undefined or not a function


Example: registration of a specific command handler
````javascript
clc.on.sync('getEnvVar', ({name}) => {
        return process.env[name];
})
````

Example: registration of the default handler ('*')
````javascript
clc.on.sync('*', (args, command)  => {
    console.log(`User called command ${command} with arguments ` +
    `${JSON.stringify(args)}`);
})
````
## on.async(command, handler)
* ````command````: string  
* ````handler````: function (arguments, command, workerName, timeoutMs)

This function registers an async command handler, i.e. a function returning a Promise object. In all other respects it is the same as ````on.sync````. 

If you mistakenly register an sync function with ````on.async````, you will get the ERR_NOT_ASYNC_HANDLER error at the next ````run````.

````on.async```` produces the same errors as ````on.sync````.

<b>N.B.:  Async handlers using callback are not supported!</b>

Example:
````javascript
var request = require('request');

clc.on.async('wget', ({url}) => {
    return new Promise((resolve, reject) => {
        request(url, (err, response) => {
            if (err) reject(err);
            else resolve(response);
        })
    })
})
````

````on.sync```` produces the same errors as ````on.async````.
<h2 id="run">run(workerName, command [, args] [, timeoutMs] [, callback])</br>
run(command [, args] [, timeoutMs] [, callback]) </h2>


* ````workerName````: string (only in master mode) 
* ````command````: string 
* ````args````: object
* ````timeoutMs````: number
* ````callback````: function(err, data)
* ````returns````: id (for the callback version, see ```cancel```) or Promise

This function executes a command registered in another thread.
The first version is used in master mode, the second in worker mode. 

````workerName```` is the name of the target worker (only in master mode). It is not possible for a worker to run commands in another worker. However, in master code it is possible to specify ````workerName == 'master' ````. In this special case the master runs the command directly in its own thread, bypassing the inter-process communication mechanisms. This is very practical if master and workers are running the same code and you need to send the same command to all instances, like in the following example:

````javascript
...
let promises = [];

for (let workerName in ['master',...clc.getWorkerNames()])
    promises.push(run(workerName,'getStatus'));
let status = await Promise.all(promises);
...    
````

````command```` is the name of a previously registered command 

````args```` is passed to the command handler and can be anything of type 'object' which can be serialized and de-serialized by JSON.

````timeoutMs```` specifies a timeout interval in millisecods. If it is omitted, the default timeout interval is used (default is currently 5 minutes). A value of 0 means that no timer will be set. 

````handler````: a command handler funtion of the type ````function(command, args, timeoutMs)````.

The callback version of ````run```` returns an id which can be used to cancel the command  (see ````cancel````). In the promise version, this id can be got through the  ````id```` property of the returned promise (again, see ````cancel```` for an example).

````run```` can produce the following errors (error.code):

* ERR_TOO_MANY_ARGUMENTS: self-explanatory
* ERR_WORKERNAME_NOT_STRING: self-explanatory
* ERR_COMMAND_NOT_STRING: self-explanatory
* ERR_INVALID_COMMAND: command was not registered
* ERR_WORKERNAME_DOESNT_EXIST: worker name not found in worker list
* ERR_WORKER_DEAD_OR_DISCONNECTED: self-explanatory
* ERR_COMMAND_CANCELED: command was canceled using the ```cancel``` function
* ERR_NOT_SYNC_HANDLER: : command handler should be registered with ````on.async````
* ERR_NOT_ASYNC_HANDLER: command handler should be registered with ````on.sync````
* ERR_COMMAND_TIMED_OUT: command didn't execute within ````timeoutMs```` milliseconds
* ERR_PENDING_OVERFLOW  the default maximum of currently pending commands exceeded (default: 1000, see ```setOptions```)


<h2 id="ready">ready([data])</h2

* ```data```: anything JSON.stringifiable

This function is called by a worker after it is initialized and ready to receive commands from master.

````data```` is passed to the ````forkWait```` function and can be anything which can be handled by ````process.run```` (basically JSON.stringifiable)

````ready```` doesn't produce errors.


<h2 id="failed">failed([err])</h2

* ```err```: Error object or anything  JSON.stringifiable

This function is called by a worker when initialization failed and the worker cannot receive commands from master.

````err````  is optional and is passed back to ````forkWait````. When omitted, an ERR_WORKER_FAILED error is generated and passed to ```forkWait```.

After calling ````failed```` the worker typically exits with ````cluster.worker.kill()````.

````failed```` doesn't produce errors.


<h2 id="cancel">cancel(id)</h2

* ````id````: string

This function allow to cancel a pending command created by ````run````. The command is immediately terminated with an ERR_COMMAND_CANCELED error.

````id```` is the command id originally returned by ````run````. ````cancel````  offers a more flexible way to cancel a command than the ````timeoutMs```` argument. Example: 

````javascript
let id = clc.run('worker', 'sluggish', 0, (err, data) => {...});  // no timer
...
...
if (bored) cancel(id);
````
The same in promise style:

````javascript
var id;
clc.run('worker', 'sluggish', 0)   // no timer
.id(cmdId => {
    id = cmdId;
})
.then(() => {
    ...
})
.catch(err => {
    ...

if (bored) cancel(id);
````
The ```id``` property of the returned promise expects a callback function which is called with the id string. It is important to place ```.id(...) ``` before ```.then``` and ```.catch(...)``` as the latter don't return the complete promise object.


````cancel```` doesn't produce errors.

<h2 id="setoptions">setOptions(info)</h2

* ````info````: object
* ````returns````: object

This function sets the global options for cluster-cmd.

````info```` is an object of type { name: value, name : value, ...  }. Currently, the following options are available:

* ````forkWaitTimeout```` (default: 3000 - 5 min)
* ````runTimeout```` (default: 300000 ) 
* ````maxPendingCommands```` (default: 1000) 

````forkWaitTimeout```` is used  in ````forkWait````,  ```runTimeout```   in ````run````.

````maxPendingCommands```` designates the maximum number of pending commands, i.e. commands which have been started by ````run```` but which have not yet returned a reply. If this number is exceeded, the next ````run```` returns an ERR_PENDING_OVERFLOW error.

The function returns an object with the complete previous option values. Thus ````setOptions()```` can be used to obtain the current options without changing them.

````setOptions```` can produce the following errors (error.code):
* ERR_INVALID_OPTION


<h2 id="removeworkername">removeWorkerName(workerName)</h2

* ````workerName````: string
* ````returns: ````: boolean

This function removes the ```workerName : worker``` entry from the list of created workers. It is the user's responsibility to terminate the worker in the proper way. 

It returns ```true``` if the entry was found, ```false``` otherwise.


````removeWOrkerName```` doesn't produce errors.

<h2 id="getworkerbyname">getWorkerByName(workerName)</h2

* ````workerName````: string
* ````returns````: Cluster.worker object or ```undefined```

This function returns the ```Cluster.worker``` object referenced by ````workerName```` or ```undefined``` when  no such object exists.

````getWorkerByName```` doesn't produce errors.


<h2 id="getworkernames">getWorkerNames()</h2

* ````returns````:  Array

This function returns the array of all workerNames created by ````fork```` or ````forkWait````

````getWorkerNames```` doesn't produce errors.


<h2 id="myname">myName</h2

This constant contains the current worker name (in worker code) or 'master' (in master mode).



# Tests

Mocha tests are available for master and worker code: 

```
npm test test/master.js
```
and 

```
npm test test/worker.js
```
Please run the above texts separately - ```npm test``` won't work as Mocha has some subtle issues when running in multithreaded envornment (well, perhaps I could have figured it out but didn't have the time and motivation...)

<h1 id="example">Full working example:</h2

````javascript
````


```javascript
/* eslint-disable no-console */

const clc = require('cluster-cmd');

// Register a sync command handler for both master and worker
clc.on.sync('add', ([a,b]) => {  
    return a + b;
});

// Register an async command handler for both master and worker
clc.on.async('async_add', ([a,b]) => {  
    return new Promise(resolve => {
        setTimeout(() => {
            resolve(a + b);
        }, 2000)
    })
})


if (clc.myName == 'master') { 
    // code executed by master

    // fork (start) a new worker thread and name it 'worker'
    // with a timeout interval of 5 seconds ...
    console.log(`${clc.myName}: starting worker`);
    clc.forkWait('worker', 5000) 

    // ... and wait until it has sent a 'ready' message   
    .then(async () => {  
        console.log(`${clc.myName}: received 'ready' from worker`); 
        
        // Run worker's 'add' command:
        let sum = await clc.run('worker','add',[3,4]); 
        console.log(`${clc.myName}: 3 + 4 =  ${sum}`)  // master: sum is 7 

        // Run worker's 'async_add' command in the same way:
        sum = await clc.run('worker','async_add',[3,4]); 
        console.log(`${clc.myName}: 3 + 4 =  ${sum}`)  // master: sum is 7 

        // Alternatively, you can use promise syntax:
        sum = await clc.run('worker','add',[3,4])
        .then(sum => {
            console.log(`${clc.myName}: 3 + 4 = ${sum}`)  // master: sum is 7
        })

        // or good old callback syntax:
        sum = await clc.run('worker','async_add',[3,4], (err, sum) => {
             if (err) console.log(err);
             else console.log(`${clc.myName}: 3 + 4 = ${sum}`)  // master: sum is 7
        })

        // Execute worker's 'doSomethingUseful' command in the same way
        console.log(`${clc.myName}: calling worker's 'calculate' command`)  
        await clc.run('worker','calculate'); 

        // Terminate worker
        let worker = clc.getWorkerByName('worker');
        worker.on('exit', () => {
            console.log(`${clc.myName}: worker terminated`)
        })
        worker.process.kill();
    })

    // If the worker does not signal 'ready' within 5 seconds
    // forkAndWait rejects with an 'ETIMEDOUT' error. 
    .catch(err => {
        console.log(`Worker timed out: ${err}`) // ETIMEDOUT error
    })
}
else if (clc.myName == 'worker') { 
    // code executed by worker

    // Register async command handler
    clc.on.async('calculate', async () => {
        // Call master's 'add' command
        console.log(`${clc.myName}: 5 + 7 = ${await clc.run('add',[5,7])}`); 
        console.log(`${clc.myName}: 6 + 8 = ${await clc.run('async_add',[6,8])}`); 
    })

    // Ready to receive commands
    console.log(`${clc.myName} is ready`);
    clc.ready(); 
}
```



  
