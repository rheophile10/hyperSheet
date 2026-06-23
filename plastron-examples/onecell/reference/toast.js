// Show toast with small bites taken out of it:
let toastLog = {};
let toastFading = {};
let toastTrackers = {};
let toastTimers = {};
let toastTime = 2500;
let toastClocks = { 'right': 0 };
let fadeOut = 0.475;
let toastFlags = [];

function flagToasts(keys)
{
    for( var key in keys ) {
        toastFlags[key] = keys[key];
    }
    console.log("toastFlags set");
}

var statuslog = [];
let statuslogState = 0;

function showStatus(message)
{
    statuslog.push(message);//    console.log("status:"+message);
    const el = document.getElementById('topstatusmsg');
    if( !el ) return;
    el.innerHTML = message;
}

// Show toast with small bites taken out of it:
function zeroToast(alt_type='your') { // sets the messages to blank so that a single message can stat
    if( alt_type == 'all' ) {
        toastLog = {};
    } else {
        toastLog[alt_type] = [];
    }
}

function clearToast(alt_type='your')
{
    clearTimeout(toastTimers[alt_type]);
    const toast = document.getElementById(alt_type + 'toast');
    toast.style.visibility = 'hidden';
    toast.style.animation = 'none';

    toastFading[alt_type] = false;
    toastTimers[alt_type] = -1;
    toastTrackers[alt_type] = 0;
}


function showToast(message, alt_type='your') {

    if( alt_type == 'your' )
        console.log(message);

    if( !(alt_type in toastLog) ) toastLog[alt_type] = [];
    toastLog[alt_type].push([message, new Date()]);

    let mlower = message.toLowerCase(); // autodetect flagged words
    for( var key of toastFlags ) {
        if( mlower.indexOf(key) != -1 ) {
            if( alt_type != toastFlags[key] )
                showToast(message, toastFlags[key]);
        }
    }
    toastTrackers[alt_type] = new Date().getTime();

    const toast = document.getElementById(alt_type + 'toast'); // what do you mean it's const
    if( alt_type in toastTimers && toastTimers[alt_type] != -1 ) {
        let buf = "";
        for( var i=toastLog[alt_type].length-3; i<toastLog[alt_type].length; i++ ) {
            if( i < 0 ) i = 0;
            buf += "\n<pre>" + toastLog[alt_type][i][0] + "</pre>";
        }
        toast.innerHTML = buf;

        toastFading[alt_type] = false;
    } else {
        toast.innerHTML = "<pre>" + message + "</pre>";
        if( statuslogState < 2 ) {
            toast.style.animation = 'fadeOut ' + fadeOut + 's, fadeIn 0.05s';
            toast.style.visibility = 'visible';
        }
        let tt = ( alt_type in toastClocks ) ? toastClocks[alt_type] : toastTime;
        if( tt == 0 ) {
            toast.style.animation = 'none';
            return;
        }
        toastTimers[alt_type] = setInterval(nextToast.bind(null,alt_type), tt/8);
    }
}


function nextToast(alt_type)
{
    let now = new Date().getTime();
    let tt = ( alt_type in toastClocks ) ? toastClocks[alt_type] : toastTime;

    if( toastFading[alt_type] ) {
        if( toastTrackers[alt_type] < now - (tt+fadeOut) ) { // finish fading out:
            clearInterval(toastTimers[alt_type]);
            delete toastTimers[alt_type];

            const toast = document.getElementById(alt_type + 'toast');
            toast.textContent = '';
            toastTrackers[alt_type] = 0;
            toastFading[alt_type] = false;
            //toastLog[alt_type] = [];            

            return;
        }
    } else {
        const toast = document.getElementById(alt_type + 'toast');
        if( toastTrackers[alt_type] < now - tt ) { // start fading out:
            toastFading[alt_type] = true; // it's not hidden YET...
            toast.style.visibility = 'hidden';
            toast.style.animation = 'fadeOut ' + fadeOut + 's, fadeIn 0.05s';
        } else {
            toast.style.visibility = 'visible'; // close the hidden race condition
        }
    }
}
