const {forkWait, on, ready, run, getWorkerByName, myName} = 
    require('./../index.js');

function masterCode() {
    // start thread 'worker' and wait until it is initialized
    forkWait('worker')
    .then(async () => {
        console.log('Worker initialized');

       // Run 'helloWorld' command in 'worker'
        await run('worker','helloWorld');

        // Terminate 'worker' thread
        getWorkerByName('worker').kill();   
    })
    .catch(err => {
        console.log(`Worker failed: ${err}`)
    })
}

function workerCode() {
    // Register 'helloWorld' command handler
    on.sync('helloWorld', () => {
        console.log(`From ${myName}: Hello world!`);
    })

    // Tell master that I'm ready to receive commands
    ready();
}

if (myName == 'master') {
    masterCode() 
}
else {
    workerCode();
}