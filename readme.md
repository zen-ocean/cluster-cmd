# cluster-cmd

**cluster-cmd** is a framework implementing the command-response paradigm for the Cluster module. Instead of packing IPC logic into the 'worker.on' and 'process.on' event handlers, you can  call a function in another thread pretty much the same way  you would call a local function.

Main features:

  - transparent to the NodeJS cluster module
  - master-to-worker and worker-to-master commands
  - basic master-worker synchronization
  - timeout handling


# How it works

Synchronous or asynchronous command handlers are registered using the ```on.sync```
or ```on.async``` functions, respectively.
Using the ```run```  function, these commands then can be run remotely from another thread.

Step 1:  Require cluster-cmd:
````javascript
const clc = require('cluster-cmd')
````

Step 2: Start a new worker without waiting for it to start up ...
````javascript
clc.fork('worker')
````
... or start it and wait until it has replied with 'ready' or 'failed':
````javascript
if (clc.myName == 'master') {
    clc.forkWait('worker')
    .then(() => {
        console.log('worker is ready')
    })
    .catch(err => {
        console.log(`worker initialization failed: ${err}`);
    })
}

````

Step 3: Register your command handlers, either sync: 
````javascript
clc.on.sync('add', ([a,b]) => {  
    	return a + b;
});
````

or async: 
````javascript
clc.on.async('async_add', ([a,b]) => {  
    return new Promise(resolve => {
        setTimeout(() => {
            resolve(a + b);
        }, 2000)
    })
})
````
Step 4: Inside master code, run the command - previously registered in a worker - with async/await syntax: 
````javascript
let sum = await clc.run('worker', 'add', [3,4]);
// very much like the local version: let sum = add([3,4])
````
or with promise syntax:
````javascript
clc.run('worker', 'add', [3,4])
.then(sum => {
    ...
})
````
or with good old callback syntax:
````javascript
clc.run('worker', 'add', [3,4], (err, sum) => {
    ...
})

````
Inside worker code, run the command registered by master:
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
* <a href="#getworkerbyname">getWorkerByName</a>
* <a href="#getworkernames">getWorkerNames</a>
* <a href="#removeworkername">removeWorkerName</a>
* <a href="#myname">myName</a>


<h2 id="fork">fork (workerName [,env])</h2>

* ````workerName````: string  
* ````env````: object

This function forks (starts) a new worker with the specified name. The name can be subsequently used to refer to the worker.  ````getWorkerByName(workerName)````  gets you the underlying cluster.worker object. ````getNames()```` returns an array of all worker names.

````env```` is an object whose properties will be added to the worker's process.env object. Default is {}. ````fork```` always adds the property ````'_workerName'```` holding the worker name to the worker's environment.

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

<h2 id="on">on</h2

You cannot call ```on``` directly but have to use one of the following:

## on.sync(command, handler)


* ````command````: string  
* ````handler````: function (arguments, command, workerName)

This function registers a sync command handler, i.e. a function returning a value. It can be used both in master and worker mode. A special case is  ```` command == '*'```` used to register a default command handler. 



Example: registration of a specific command handler
````javascript
clc.on.sync('getEnvVar', ({name}) => {
        return process.env[name];
})
````

Example: registration of the default handler
````javascript
clc.on.sync('*', (args, command)  => {
    console.log(`User called command ${command} with arguments ` +
    `${JSON.stringify(args)}`);
})
````
## on.async(command, handler)
* ````command````: string  
* ````handler````: function (arguments, command, workerName)

This function registers an async command handler, i.e. a function returning a Promise. In all other respects it is similar to ````onSync````.

Example:
````javascript
clc.on.sync('wget', ({url}) => {
    return new Promise((resolve, reject) => {
        request(url, (err, response) => {
            if (err) reject(err);
            else resolve(response);
        })
    })
})
````

<h2 id="run">run(workerName, command [, args] [, timeoutMs] [, callback])</br>
run(command [, args] [, timeoutMs] [. callback]) </h2>


* ````workerName````: string (only in master mode) 
* ````command````: string 
* ````args````: object
* ````timeoutMs````: number
* ````handler````: function
* ````returns````: string (for the callback version) or Promise

This function executes a command registered in another thread.
The first version is used in master mode, the second in worker mode. 

````workerName```` is the name of the target worker (only in master mode). It is not possible for a worker to run commands in another worker. It is however possible to specify ````workerName == 'master' ````. In this special case the master runs the command directly in the same thread, bypassing the inter-process communication mechanisms. This is very practical if master and workers are running the same code and you need to send the same command to all instances, like in the following example:

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

````timeoutMs```` specifies a timeout interval in millisecods. If it is omitted, the default timeout interval is used (default is 5 minutes). A value of 0 means that no timer will be set. 

````handler````: a command handler funtion of the type ````function(command, args)````.

The callback version of ````run```` returns an id which can be used to cancel the command  (see ````cancel````). In the promise version, this id can be found in  the ````pendingId```` property of the returned promise (again, see ````cancel```` for an example).

<h2 id="ready">ready([data])</h2
* data

This function is called by a worker after it is initialized and ready to receive commands from master.

````data```` is passed to the ````forkWait```` function and can be anything which can be handled by ````process.run```` (basically JSON.stringifiable)

<h2 id="failed">failed([err])</h2
* err

This function is called by a worker when initialization failed and the worker cannot receive commands from master. After calling ````failed```` the worker typically exits with ````cluster.worker.kill()````.

````err````  is an optional Error object passed to ````forkWait````.

<h2 id="cancel">cancel(id)</h2
* ````id````: string

This function allow to cancel a pending command created by ````run````. The command is terminated with an 'ECANCELED' error.

````id```` is the command id originally returned by ````run````. ````cancel````  offers a more flexible way to cancel a command than the ````timeoutMs```` argument. Example: 

````javascript
let id = clc.run('worker', 'sluggish', 0, (err, data) => {...});  // no timer
...
...
if (bored) cancel(id);
````
The same in promise style:

````javascript
let promise = clc.run('worker', 'sluggish', 0);   // no timer

promise.then(...);
promise.catch(...);

let id = promise.pendingId;
...
...
if (bored) cancel(id);
````


<h2 id="setoptions">setOptions(info)</h2

* ````info````: object
* ````returns````: object

This function sets the global options for cluster-cmd.

````info```` is an object of type {name1 : value1, name2 : value2...}. Currently, the following options are available:

* ````defaultTimeout```` (default: 300000 - 5 min)
* ````maxPendingCommands```` (default: 1000) 

````defaultTimeout```` is used when no ```timeoutMs``` argument is specified in ````forkWait```` and ````run````.

````maxPendingCommands```` designates the maximum number of pending commands, i.e. commands which have been started by ````run```` but which have not yet returned an answer. If this number is exceeded, the next ````run```` returns a 'pending overflow' error.

The function returns an object with the complete previous option values. Thus ````setOptions()```` can be used to obtain the current options without changing them.


<h2 id="getworkerbyname">getWorkerByName(workerName)</h2

* ````workerName````: string

This function returns the cluster.worker object referenced by ````workerName````

<h2 id="getworkernames">getWorkerNames()</h2

* ````returns````:  Array

This function returns the array of all workerNames created by ````fork```` or ````forkWait````


<h2 id="myname">myName</h2

This constant contains the current worker name (in worker code) or 'master' (in master mode).

<h2 id="example">Full working example:</h2

````javascript
````


```javascript
const clc = require('./cluster-cmd.js');

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
    // with a timeout interval of 5 seconds
    clc.forkWait('worker', 5000) 

    // and wait until it has sent a 'ready' message   
    .then(async () => {  
        console.log(`master: worker is ready`);
        
        // Run worker's 'add' command:
        let sum = await clc.run('worker','add',[3,4]); 
        console.log(`master: sum is ${sum}`)  // master: sum is 7

        // Alternatively, you can use promise syntax:
        sum = clc.run('worker','add',[3,4])
        .then(sum => {
            console.log(`master: sum is ${sum}`)  // master: sum is 7
        })

        // or good old callback syntax:
        clc.run('worker','add',[3,4], (err, sum) => {
             console.log(`master: sum is ${sum}`)  // master: sum is 7
        })

        // Execute worker's add_sync command in the same way
        sum = await clc.run('worker','async_add',[5,7]); 
        console.log(`master: sum is ${sum}`)  // master: sum is 12

    })

    // If the worker does not signal 'ready' within 5 seconds
    // forkAndWait rejects with an 'ETIMEDOUT' error. 
    .catch(err => {
        console.log(`Worker timed out: ${err}`) // ETIMEDOUT error
    })
}
else if (clc.myName == 'worker') { 
    // code exexuted by worker 
 
    //  signal to master that the worker is ready to 
    //  receive commands.
    clc.ready(); 

    // Run master's 'add' command (see master section for variants)
    clc.run('add',[3,4])
    .then(sum => {
        console.log(`${clc.myName}: sum is ${sum}`)  // worker: sum is 7
    }) 
    // Run master's 'async_add' command (see master section vor variants)
    clc.run('async_add',[5,7])
    .then(sum => {
        console.log(`worker: sum is ${sum}`)  // worker: sum is 12
    }) 
}
```



  
