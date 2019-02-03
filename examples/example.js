const {forkWait, on, run, ready, getWorkerByName, myName} = 
    require('./../index.js');

// Register a sync command handler for both master and worker
on.sync('add', ([a,b]) => {  
    return a + b;
});

// Register an async command handler for both master and worker
on.async('async_add', ([a,b]) => {  
    return new Promise(resolve => {
        setTimeout(() => {
            resolve(a + b);
        }, 2000)
    })
})


if (myName == 'master') { 
    // code executed by master

    // fork (start) a new worker thread and name it 'worker'
    // with a timeout interval of 5 seconds ...
    console.log(`${myName}: starting worker`);
    forkWait('worker', 5000) 

    // ... and wait until it has sent a 'ready' message   
    .then(async () => {  
        console.log(`${myName}: received 'ready' from worker`); 
        
        // Run worker's 'add' command:
        let sum = await run('worker','add',[3,4]); 
        console.log(`${myName}: 3 + 4 =  ${sum}`)  // master: sum is 7 

        // Run worker's 'async_add' command in the same way:
        sum = await run('worker','async_add',[3,4]); 
        console.log(`${myName}: 3 + 4 =  ${sum}`)  // master: sum is 7 

        // Alternatively, you can use promise syntax:
        sum = await run('worker','add',[3,4])
        .then(sum => {
            console.log(`${myName}: 3 + 4 = ${sum}`)  // master: sum is 7
        })

        // or good old callback syntax:
        sum = await run('worker','async_add',[3,4], (err, sum) => {
             if (err) console.log(err);
             else console.log(`${myName}: 3 + 4 = ${sum}`)  // master: sum is 7
        })

        // Execute worker's 'doSomethingUseful' command in the same way
        console.log(`${myName}: calling worker's 'calculate' command`)  
        await run('worker','calculate'); 

        // Terminate worker
        let worker = getWorkerByName('worker');
        worker.on('exit', () => {
            console.log(`${myName}: worker terminated`)
        })
        worker.process.kill();
    })

    // If the worker does not signal 'ready' within 5 seconds
    // forkAndWait rejects with an 'ETIMEDOUT' error. 
    .catch(err => {
        console.log(`Worker timed out: ${err}`) // ETIMEDOUT error
    })
}
else if (myName == 'worker') { 
    // code executed by worker

    // Register async command handler
    on.async('calculate', async () => {
        // Call master's 'add' command
        console.log(`${myName}: 5 + 7 = ${await run('add',[5,7])}`); 
        console.log(`${myName}: 6 + 8 = ${await run('async_add',[6,8])}`); 
    })

    // Ready to receive commands
    console.log(`${myName} is ready`);
    ready(); 
}