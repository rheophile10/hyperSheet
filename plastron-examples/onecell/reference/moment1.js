export var rulesets = [
[
  { 
    min_birth: 0.05, max_birth: 0.06,
    min_death: 0.04, max_death: 0.5,
    min_lifer: 0.25, max_lifer: 0.33,
  }
], //1:
[
  {
    cond: { above: 10000 },
    min_birth: 0.012, max_birth: 0.013,
    min_death: 0, max_death: 0.02,
    min_lifer: 1, max_lifer: 0,
  },
  { 
    min_birth: 0.1, max_birth: 0.2,
    min_death: 0, max_death: 0.5,
    min_lifer: 0, max_lifer: 0.4,
  },
],
];

let join_walls = true;
let opacity = 0.66; // 0.86;
let sizing = 1.0; // 0.6 // 0.92;
let spacing = 1.5; // 1.65;
var usefreq=0.25;
let neighbor_range = 3;
let network_strength = 2;
var start_health = 50; // 10
let damage = 250;
let damage_entropy = 0.25;
let healing_factor = 0.01; // 0.01
let healing_constant = 10;
let life_per_tick = 10;

let adversity = 0.14;
const maxScaling = sizing*spacing*1.03;
const minScaling = 0.001;

let barrier_point = 0.33;
let barrier_width = 0.008;
let barrier_distance = 0.002;
let max_health = 2500;


import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { bin_decode, bin_encode } from '/js/binary.js';

export let paused=false, running=false, gravTimeout=45, gravTimer=-1;
export var neighbors = null, cells = null, lifetime = null;
export var forces = null;
export var wires = [];
export var posns = null;

let changing_rules = false;

function updateBarrier() {
    let cfg = rulesets[1];

    cfg[0].max_death = barrier_point + barrier_width + barrier_distance;
    cfg[0].min_birth = barrier_point;
    cfg[0].max_birth = barrier_point + barrier_width;

    if( cfg.length > 1 ) {
        let bp = barrier_point/2, bw = barrier_point/2 + barrier_width*2;
        cfg[1].max_death = bp + bw + barrier_distance;
        cfg[1].min_birth = bp;
        cfg[1].max_birth = bp + bw;
    }

    decideRule(true);
}

let startup_size = 64;
let fullW=startup_size, fullH=startup_size, fullD=startup_size;
export let total_cells= startup_size * startup_size * startup_size;
let silent=false;
let running_cells = false;
let use_full_rules = true;
let rules_stick = true;
const force_multiplier = 1;
let zeroGroundBalance = false;

var fax, additionalAirie;

let pressure_damage = 10;
let life_per_sec = 0; // 400
let chosen_fov = 67;
let qtzero = new THREE.Quaternion(0,0,0,1);
let rule_mult = 0;
let fire_length = 20;
let lifers_first=false;
let rule_reversal = [];
let neighborOffsets = [];
let chosen_rules = 0;

export var rules = rulesets[1];
let fade_toning = true;
let silver_toning = false;
let sneaker_toning = true;

let scene=null, renderer=null;
let instances = null;

var material, geometry;
var controls = null, camera;

var rNums = [], rC = 0, cC = 0, rndMax=2000;
let last_frame = 0;

let current_mult=0;
let current_rule=false, current_rules = '9';
let camera_vel = [0,0,0];
let camera_tgt_vel = [0,0,0];
let camera_dist = 0;
let last_time = 0;
let colorMode = 0;
let lastSwitch = 0;
let timer_mode = 1;
let show_status=false;
let experiment=0;
var canvas, ctx, img;
let staccato = false;
var renderTimer;

let lastTick = 0;
var fpsnow;
let lastChart = null;
let lastFrames = [];
let gravAdjust = 100;
let userWork = false; // for now
let cpuWork = false;
let cyclesPerFrame = 5;
let used_time = 0;
let slowed_down=0, sped_up=0, was_greedy=0;
let fpsMap = new Map();
let fpsLimit = {0:100};
let fpsMax = 42;
let min_grav_adjust = fpsMax/1000;
let learnLockLoseState = 0;
let lockIsHard = false;
let timerMode = [ 'learn', 'lock', 'lose' ];
let superslower = 0;

let colorsets = [
  [ 'purple', [6,0,28], [0,0,10] ],
  [ 'bluegreen', [-25,-1,20], [25,0,-5] ],
  [ 'scanning', [-5,-4,5], [5,7,-5] ],
  [ 'brightscan', [-2,-1,25], [25,30,-25] ],
  [ 'darkness', [-1.3, -1, 10], [8, 0, 0] ],
  [ 'light', [10,7,2.5], [-0.5,0,-1] ],
  [ 'test', [1,0,0], [0,0,1] ]
];
let no_visual_import = true;
let no_rules_import = false;
let imported_static_rules = null;

let colorpick = 0;
let lastColorPick = 0;

export let groundBal = [0,0,0];
export let colorBal = colorsets[colorpick][1];
export let filterBal = colorsets[colorpick][2];

let fill_red = filterBal[0];
let fill_green = filterBal[1];
let fill_blue = filterBal[2];


export let total_alive=0;

let bugcount = 0;

let app_state=0, app_iter=0;
let cpu_work=false;
let rules_multed=false;

// calculate cell count multiplier for rules.
function setRuleMult()
{
  rule_mult=-1;
  for( var e = -neighbor_range; e <= neighbor_range; e++ ) {
    for( var f = -neighbor_range; f <= neighbor_range; f++ ) {
      for( var g = -neighbor_range; g <= neighbor_range; g++ ) {
        rule_mult++;
      }
    }
  } 
  if( rules_multed != rule_mult && current_rule !== false ) {
    rules_multed = rule_mult;
    showToast("Rule multiplier: " + rule_mult);
    min_birth = Math.floor( rules[current_rule].min_birth*rule_mult );
    max_birth = Math.ceil( rules[current_rule].max_birth*rule_mult );
    min_lifer = Math.floor( rules[current_rule].min_lifer*rule_mult );
    max_lifer = Math.ceil( rules[current_rule].max_lifer*rule_mult );
    min_death = Math.floor( rules[current_rule].min_death*rule_mult );
    max_death = Math.ceil( rules[current_rule].max_death*rule_mult );
  }
}
export function startupOneCell()
{
    start();
    genereateRandom(total_cells*usefreq);
    resizeScreen(); // starts the animation as well if not already running.
}

export function restartScreen() {
    // initialize
    cpu_work = false;
    paused = false;
    running_cells = true;
    animate();
}


function livingBorders()
{
  var min_x, max_x, min_y, max_y, min_z, max_z;
  var x,y,z,p;
    
  min_x = fullW-1;
  min_y = fullH-1;
  min_z = fullD-1;
  max_x = 0;
  max_y = 0;
  max_z = 0;
    
  for( p=0,z=0; z<fullD; z++ ) {
    for( y=0; y<fullH; y++ ) {
      for( x=0; x<fullW; x++,p++ ) {
        if( cells[p] != 0 ) {
          min_x = Math.min(min_x,x);
          min_y = Math.min(min_y,y);
          min_z = Math.min(min_z,z);
          max_x = Math.max(max_x,x);
          max_y = Math.max(max_y,y);
          max_z = Math.max(max_z,z);
        }
      }
    }
  }
  return [ min_x, max_x, min_y, max_y, min_z, max_z ];
}

function resizeTo(newsize)
{
  cpu_work = true;
  
  wires = [];

  // re-center on newly generated area:
  let fullSize = newsize*newsize*newsize;
  let cellmap = new Uint16Array(fullSize);
  let lifemap = new Uint32Array(fullSize);
  let neighbormap = new Uint16Array(fullSize);
  let posnsmap = new Uint16Array(fullSize);
  let forcemap = new Array(fullSize);
  
  var z,x,y,x0,y0,z0;
  var p, q;
  
  if( newsize > fullW ) {
    let offsize = parseInt((newsize-fullW)/2);

    x=y=z=0;
    z0 = z-offsize;
    y0 = y-offsize;
    x0 = x-offsize;
    for( p=0; p<fullSize; p++ ) {

        if( z0 < 0 || y0 < 0 || x0 < 0 || z0 >= fullD || y0 >= fullH || x0 >= fullW ) {
            cellmap[p] = 0;
            lifemap[p] = 0;
            neighbormap[p] = 0;
            posnsmap[p] = 1;
            forcemap[p] = [0,0,0];
        } else {
            q = z0*fullH*fullW + y0*fullW + x0;
            cellmap[p] = cells[q];
            lifemap[p] = lifetime[q];
            neighbormap[p] = neighbors[q];
            if( cells[q] == 0 ) {
                posns[p] = 1;
            } else {
                posns[p] = 0;
            }
            forcemap[p] = forces[q];
        }

        x++;
        if( x >= fullW ) {
            x=0;
            y++;

            if( y >= fullH ) {
                y=0;
                z++;
                z0 = z-offsize;
            }
            y0 = y-offsize;
        }
        x0 = x-offsize;
    }
    /*
    for( z=0; z<newsize; z++ ) {
      z0 = z-offsize;
      cellmap[z] = new Array(newsize);
      lifemap[z] = new Array(newsize);
      neighbormap[z] = new Array(newsize);
      posnsmap[z] = new Array(newsize);
      for( x=0; x<newsize; x++ ) {
        x0 = x+offsize;
        cellmap[z][x] = new Array(newsize).fill(0);
        lifemap[z][x] = new Array(newsize).fill(0);
        neighbormap[z][x] = new Array(newsize).fill(0);
        posnsmap[z][x] = new Array(newsize).fill(0);
        for( y=0; y<newsize; y++ ) {
          y0 = y+offsize;
          if( z0 < 0 || y0 < 0 || x0 < 0 || z0 >= fullD || y0 >= fullH || z0 >= fullW ) {
            cellmap[z][x][y] = 0;
            lifemap[z][x][y] = 0;
            neighbormap[z][x][y] = 0;
            posnsmap[z][x][y] = 0;
            continue;
          }
          cellmap[z][x][y] = cells[z0][x0][y0];
          lifemap[z][x][y] = lifetime[z0][x0][y0];
          neighbormap[z][x][y] = neighbors[z0][x0][y0];
          posnsmap[z][x][y] = posns[z0][x0][y0];
        }
      }
    }
    */
  } else {
    var min_x, max_x, min_y, max_y, min_z, max_z;
    [ min_x, max_x, min_y, max_y, min_z, max_z ] = livingBorders();
    
    let offsize = parseInt((fullD-newsize)/2);


    x=y=z=0;
    z0 = z+min_z;
    y0 = y+min_y;
    x0 = x+min_x;
    for( p=0; p<fullSize; p++ ) {

        if( z0 < 0 || y0 < 0 || x0 < 0 || z0 >= fullD || y0 >= fullH || x0 >= fullW ) {
            cellmap[p] = 0;
            lifemap[p] = 0;
            neighbormap[p] = 0;
            posnsmap[p] = 1;
            forcemap[p] = [0,0,0];
        } else {
            q = z0*fullH*fullW + y0*fullW + x0; // use old measurements to get q
            cellmap[p] = cells[q];
            if( cells[q] == 0 ) {
                posns[p] = 1;
            } else {
                posns[p] = 0;
            }
            lifemap[p] = lifetime[q];
            neighbormap[p] = neighbors[q];
            posnsmap[p] = posns[q];
            forcemap[p] = forces[q];
        }

        x++;
        if( x >= newsize ) {
            x=0;
            y++;
            if( y >= newsize ) {
                y=0;
                z++;
                z0 = z+min_z;
            }
            y0 = y+min_y;
        }
        x0 = x+min_x;
    }

    /*    
    for( z=0; z<newsize; z++ ) {
      z0 = z+min_z;
      cellmap[z] = new Array(newsize);
      lifemap[z] = new Array(newsize);
      neighbormap[z] = new Array(newsize);
      posnsmap[z] = new Array(newsize);
      for( x=0; x<newsize; x++ ) {
        x0 = x+min_x;
        cellmap[z][x] = new Array(newsize).fill(0);
        lifemap[z][x] = new Array(newsize).fill(0);
        neighbormap[z][x] = new Array(newsize).fill(0);
        posnsmap[z][x] = new Array(newsize).fill(0);
        for( y=0; y<newsize; y++ ) {
          y0 = y+min_y;
          if( z0 < 0 || x0 < 0 || y0 < 0 || z0 >= fullD || x0 >= fullW || y0 >= fullH ) {
            cellmap[z][x][y] = 0;
            lifemap[z][x][y] = 0;
            neighbormap[z][x][y] = 0;
            posnsmap[z][x][y] = 0;
            continue;
          }
          cellmap[z][x][y] = cells[z0][x0][y0];
          lifemap[z][x][y] = lifetime[z0][x0][y0];
          neighbormap[z][x][y] = neighbors[z0][x0][y0];
          posnsmap[z][x][y] = posns[z0][x0][y0];
        }
      }
    }
    */
  }
  
  cells = cellmap;
  lifetime = lifemap;
  neighbors = neighbormap;
  posns = posnsmap;
  forces = forcemap;
  total_cells = fullSize;
  
  fullW = fullH = fullD = newsize;
  buildInstances();
  cpu_work = false;
}

export function getSizing() {
    return sizing;
}
export function getSpacing() {
    return spacing;
}
export function setSpacing(s) {
    spacing = s;
    showToast("Spacing: " + spacing);
    resetCamera();
    refreshConfig();
}
export function setSizing(s) {
    sizing = s;
    showToast("Sizing: " + sizing);
    resetCamera();
    refreshConfig();
}
export function setOpacity(o) {
    opacity = o;
    showToast("Opacity: " + opacity);
    refreshConfig();
}
export function one(js) {
    eval(js);
}
export function tell() {
    console.log(JSON.stringify({total_alive,damage,damage_entropy,healing_factor,healing_constant}));
}


export function setColorBal(value, rgb, cm)
{
    var rgbColor;
    lastColorPick = rgb;

    switch( rgb ) {
    case 0:
        rgbColor = 'Red: ';
        break;
    case 1:
        rgbColor = 'Green: ';
        break;
    case 2:
        rgbColor = 'Blue: ';
        break;
    default:
        console.log("setColorBal undefined " + rgb);
        return;
    }
    showToast(rgbColor + value);

    switch( cm ) {
        case 0: colorBal[rgb] = 0+value; break;
        case 1: filterBal[rgb] = 0+value; break;
        case 2: groundBal[rgb] = 0+value; break;
    }
    fill_red = filterBal[0];
    fill_green = filterBal[1];
    fill_blue = filterBal[2];
}




export function pause() {
    paused=!paused;
}


function backupCycler() {
    if( lastTick < new Date().getTime() - 1000 ) {
        animate();
    }
}

// provide random noise to cpu
function burner() {
    let cycles = qRandom(50);
    var a,b,c,d,e,f,g;
    while( cycles > 0 ) {
        a=qRandom();
        b=2*a;
        c=b/3;
        d=2*c;
        e=d/3;
        f=2*e;
        g=parseInt(f/3);
        g-=g+1;
        cycles--;
    }
    return g;
}
let last_timer_mode = 'f';
export function animate() { // a 'no' comment :)
    if( timer_mode != last_timer_mode ) {
        last_timer_mode = timer_mode;
        clearInterval(gravTimer);
    }
    switch( timer_mode ) {
        case 0:
            animate_1();
            break;
        case 1:
            watchTimer();
            break;
        case 2:
            animate_2();
            break;
        case 3:
            useAnimationFrames();
            break;
    }
}
export function nextTimer() {
    timer_mode = (timer_mode+1)%4;
    showToast("Timer mode: " + ['anim_1','watch','anim_2','requestframe'][timer_mode]);
    showStatus(['old','watch','1','animframes'][timer_mode]);
    paused = false;
    running = false;
    cpu_work = false;
    gravTimeout = 30;
    resizeScreen();
}

export function animate_1() {
    if( paused ) return;
    if( running ) {
        return;
    } else {
        running = true;
    }
    var tn = new Date();

    application();

    var tx = new Date();
    var td = tx - tn;
    var chg=false;
    if( gravTimeout == 0 ) {
        chg=true;
        gravTimeout = 50;
    } else if( gravTimeout < 1.5*td ) { // using too much cpu.
        gravTimeout *= 1.5;
        chg=true;
    } else if( gravTimeout > td*4 ) { // going too slowly.
        gravTimeout /= 1.5;
        chg=true;
    }
    if(chg){
        clearInterval(gravTimer);
        gravTimer = setInterval( animate, gravTimeout );
        if( gravTimeout > 6000 )
            showToast("gt="+gravTimeout);
    }
    //showToast(td, tn.getSeconds(), tx.getSeconds());
    running=false;
}

export function useAnimationFrames()
{
    application();
    requestAnimationFrame(animate);
}


export function animate_2() {
    if( paused ) return;
    if( running ) return;
    else running = true;

    let tn = new Date();
    application();
    let tx = new Date();
    let td = tx - tn;

    let chg=false;
    if( gravTimeout < 1.5*td ) { // using too much cpu.
        gravTimeout *= 1.5;
        chg=true;
    } else if( gravTimeout > td*4 ) { // going too slowly.
        gravTimeout /= 1.5;
        chg=true;
    }
    if(chg){
        clearInterval(gravTimer);
        gravTimer = setInterval( "animate()", gravTimeout );
        if( gravTimeout > 6000 )
            showToast("gt="+gravTimeout);
    }
    running=false;
}


export function setMaxFPS(v)
{
    fpsMax = parseInt(v);
}

export function getStats()
{
    return [fpsLimit,fpsMap];
}

function watchTimer()
{
    lastTick = new Date().getTime();

    if( paused ) {
        requestAnimationFrame( finishRendering );
        renderTimer = setTimeout( animate, 200 );
        return;
    } else {
      renderTimer = -1;
    }

    // measure fps
    let tn = lastTick;
    
    while( lastFrames.length > 0 && lastFrames[0] < tn-1000 )
        lastFrames.shift();

    fpsnow = lastFrames.length;
    if( learnLockLoseState == 0 ) { // learning:
        if( !(fpsnow in fpsLimit) ) {
            var i;
            for( i=fpsnow-1; i>=0; i-- ) {
                if( i in fpsLimit ) {
                    //console.log("fpsLimit[" + i + "]=" + fpsLimit[i] + "->" + fpsnow);
                    while( i < fpsnow ) {
                        fpsLimit[i+1]=fpsLimit[i]*0.95;
                        i++;
                    }
                    break;
                }
            }
            if( i <= 0 ) {
                fpsLimit[0] *= 2;
            }
        }
    }

    if( fpsnow != 0 ) {

        if( lastChart === null ) {
            lastChart = tn;
        }
        if( lastChart < tn - 400 ) {
            //chartFps();
            showStatus(timerMode[learnLockLoseState] + " @fps=" + fpsnow + "         pS:" + sped_up + "     Sp\\:" + was_greedy + ( slowed_down > 0 ? (" Gr." + slowed_down + "!..") : " __._!.." ));

            if( learnLockLoseState == 0 ) {
                var f;
                if( fpsMap.has(fpsnow) ) {
                    f = fpsMap.get(fpsnow);
                    f.push( [0+slowed_down,0+sped_up,0+was_greedy] );
                    if( f.length > 9 ) f.shift();
                } else {
                    f = [ [0+slowed_down,0+sped_up,0+was_greedy] ];
                    fpsMap.set(fpsnow, f);
                }

                slowed_down=0;
                sped_up=0;
                was_greedy=0;

            }


            lastChart = tn;
        }
    }

    // if lockIsHard && learnLockLoseState == 1 we skip this
    if( (!lockIsHard || learnLockLoseState != 1 ) && fpsnow != 0 && used_time > 1000/fpsnow ) { // uusing increasing amts of time
        if( gravAdjust == 0 ) gravAdjust = 1;
        gravAdjust *= 1.11;
        slowed_down++;
    }

    if( fpsnow > fpsMax ) {
        // slow down
        gravAdjust *= 1.1;
        superslower++;
    }


    if( fpsnow > fpsMax ) {
        renderTimer = setTimeout( animate, gravAdjust );
        return;
    }
    
    try {
        lastFrames.push(tn);
        if( application() ) {
            let tx = new Date().getTime();
            used_time = tx-tn;
        }
    } catch( e ) {
        used_time=0;
        console.log(e, "appplication");
    }

    renderTimer = setTimeout( animate, gravAdjust );    

    if( fpsMap.has(fpsnow) && ( learnLockLoseState != 1 || !lockIsHard ) ) { 
        let fm = fpsMap.get(fpsnow);
        let slowedThen=0;
        let relativelySlow = slowed_down * fm.length;
        for( var i=0; i<fm.length; i++ ) {
            slowedThen += fm[i][0];
        }
        if( fm.length != 0 && slowedThen > 0 ) {
            if( relativelySlow > slowedThen*1.1 ) {
                gravAdjust *= 0.95;
                sped_up++
            } else if( relativelySlow < slowedThen*0.9 ) {
                gravAdjust *= 1.1;
            }

            let oldValue = gravAdjust;
            if( fpsnow>0 && learnLockLoseState != 1 ) {
                let fp = fpsnow+1;
                if( fp in fpsLimit ) {
                    oldValue = (fpsLimit[fp] + gravAdjust)/2;
                    // fpsLimit+1 max=333,*=1.1
                    //fpsLimit[fp] = Math.min(333, fpsLimit[fp]);
                } else { // oldValue max=333,gravAdjust*3/4
                    oldValue = gravAdjust*0.75;
                }
                oldValue = Math.min(333, oldValue);

                if( fpsnow in fpsLimit ) // oldValue max=333,2*fpsLimit(now)
                    oldValue = Math.min(2*fpsLimit[fpsnow], oldValue);

                gravAdjust = oldValue;
                if( learnLockLoseState == 0 ) { // locked|losing = don't alter record
                    fpsLimit[fpsnow] = oldValue;
                }
            }
        }
    }


    if( (gravAdjust<min_grav_adjust) || ( fpsnow in fpsLimit && gravAdjust < fpsLimit[fpsnow]*0.5 ) ) {
        gravAdjust=Math.max(min_grav_adjust,fpsLimit[fpsnow]); // don't get too picky
        was_greedy++;
    }

    if( !lockIsHard || learnLockLoseState != 1 ) {
        gravAdjust *= 0.99;
        sped_up++
    }
}

function chartFps() {
    let diffs = [];
    for( var i=0; i<lastFrames.length-1; i++ ) {
        diffs.push( lastFrames[i+1] - lastFrames[i] );
    }
    console.log(new Date().getSeconds() + ": " + diffs.join("->"));
    //console.log("fps: " + lastFrames.length)
}


function qRandom() { // note we do use the arguments[] list
    if( rNums.length < rndMax ) {
        startRandoms();
    }
    rC++;
    if( rC >= rNums.length ) rC -= rNums.length;
    cC += Math.floor( rNums[rC] * 50 );
    while( cC >= rNums.length ) cC -= rNums.length;
    let x = (rNums[rC]*0.1 + rNums[cC]*0.9);

    return !(0 in arguments) ? (x) : ( !(1 in arguments) ? ( x * arguments[0] ) : ( arguments[0] + arguments[1]*x ) );
};
function startRandoms() {
    while( rNums.length < rndMax ) {
        rNums.push( Math.random() );
    }
}
function checkWebGLStatus(msgs) {
    const canvas = document.createElement('canvas');
    let gl = null;
    try {
        gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    } catch (e) {
        msgs.push(e);
    }

    if (!gl) {
        msgs.push("WebGL is not supported or is disabled.");
        return false;
    }
    
    // Use an extension to get specific driver info if available
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    let vendor = "N/A";
    let renderer = "N/A";
    if (debugInfo) {
        vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
        renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
    }
    
    // Check if a major performance caveat caused it to use software rendering
    const performanceCaveat = gl.getContextAttributes().failIfMajorPerformanceCaveat ? "Yes" : "No";

    msgs.push(`WebGL Status: Supported. Vendor: ${vendor}, Renderer: ${renderer}, Major Performance Caveat: ${performanceCaveat}`);
    return true;
}


function finishRendering() // out of band i guess, kind of a primitive way to do it
{
    //this.instances.computeBoundingBox();
    if( staccato || cpu_work ) return;

    controls.update();
    renderer.render(scene, camera);
}
// Call this function and log the result

function buildCanvas()
{    
    const el = document.getElementById('mainscroll');
    var rv = [];

    if( !checkWebGLStatus(rv) ) {
        console(rv, rv.join("\n"));
        alert(rv.join("\n"));
        return false;
    }

    renderer = new THREE.WebGLRenderer({
        //antialias: false,
        alpha: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        logarithmicDepthBuffer: true,
        reverseDepthBuffer: false
    });
    renderer.setPixelRatio( window.devicePixelRatio );
    renderer.setSize( window.innerWidth, window.innerHeight );

    el.appendChild( ( canvas = renderer.domElement ) );
    el.style.position = 'absolute';
    el.style.top = '0px';
    el.style.left = '0px';
    return true;
}

function threeCanvas()
{
    const el = document.getElementById("mainscroll");
    if( renderer !== null ) {
        for( var i=0; i<el.children.length; i++ ) {
            if( el.children[i].nodeName.toLowerCase() == 'canvas' ) {
                el.removeChild( el.children[i] );
                --i;
            }
        }
        renderer = null;
    }

    if( !buildCanvas() ) {
        renderer = null;
        return false;
    }

    buildScene(); // also calls buildInstances()

    camera = new THREE.PerspectiveCamera( chosen_fov, window.innerWidth / window.innerHeight, 0.1, 10000 );
    resetCamera();

    useTrackball();
    trackToCamera();
    return true;
}

function buildScene()
{
    if( scene !== null ) {
        scene = null;
    }
    scene = new THREE.Scene();
    scene.background = new THREE.Color( groundBal[0]/255, groundBal[1]/255, groundBal[2]/255 );
    let light = new THREE.AmbientLight(0xffffff, 2.3);
    scene.add(light);
    buildInstances();
}
function resetCamera() {
    camera.position.set( fullW*spacing*0.5, fullH*spacing*0.5, -1.4*fullD*spacing );
    camera.lookAt(new THREE.Vector3(fullW*spacing*0.5, fullH*spacing*0.5, fullD*spacing*0.5) );//fullW*spacing*0.5, fullH*spacing*0.5, fullD*spacing*0.5));
    if( controls !== null ) {
      controls.reset();
      camera.updateProjectionMatrix();
    }
}

function trackToCamera() {
  let extents = livingBorders();
  let mid_x = (extents[1] - extents[0])/2 + extents[0];
  let mid_y = (extents[3] - extents[2])/2 + extents[2];
  let mid_z = (extents[5] - extents[4])/2 + extents[4];
  //alert(mid_x + "," + mid_y + "," + mid_z);
  controls.reset();
  camera.position.set( mid_x*spacing, mid_y*spacing, -1.4*mid_z*spacing );
  controls.target = new THREE.Vector3(mid_x*spacing, mid_y*spacing, mid_z*spacing);
  camera.lookAt( controls.target );
  camera.updateProjectionMatrix();
}


function getCameraControls()
{
    return [camera,controls];
}

function useTrackball()
{
    controls = new TrackballControls( camera, renderer.domElement );
    controls.rotateSpeed = 160.0;
    controls.zoomSpeed = 5;
    controls.panSpeed = 5.0;
    controls.staticMoving= true;
    controls.keys = []; // [ 'KeyA', 'KeyS', 'KeyD' ];
}

function refreshConfig(reset_camera=false)
{
    if( reset_camera ) {
        resetCamera();
    }

    if( qRandom(bugcount) > 0.5 ) { // if there's a bug. only do it half the time. mock the system.
        console.log("ha ah ah ah ha ah ah ah ha ah ah ah and why");
        updateInstances(true);
    } else {
        buildInstances();
    }
}
function buildInstances()
{
    if( instances !== null ) {
        instances.dispose();
        instances=null;
        buildScene(); // calls buildInstances again
        return;
    }
    if( scene === null ) {
        buildScene();
        return;
    }
    geometry = new THREE.BoxGeometry( sizing, sizing, sizing );
    // ? geometry.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, 0.5)); /// oooooer

    if( opacity >= 0.999 ) {
        material = new THREE.MeshBasicMaterial( {color:0xffffff} );
        material.transparent = false;
    } else {
        material = new THREE.MeshLambertMaterial( {color:0xffffff} );
        // try MeshLambert, MeshPhysical, MeshNormal, MeshPhong, MeshToon
        material.transparent = true;
        material.opacity = opacity;
    }
    instances = new THREE.InstancedMesh( geometry, material, total_cells );
    //instances.castShadow = instances.receiveShadow = true;
    //instances.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
    updateInstances(true);
    scene.add(instances);
}



// Runtime loop:

let sneakerSomeHow = new Map();

export function start() {
    setRuleMult();
    prepareNeighbors();
    console.log("start()");

    total_cells = fullW*fullH*fullD;
    cells = new Uint16Array(total_cells);
    lifetime = new Uint32Array(total_cells);
    neighbors = new Uint16Array(total_cells);
    posns = new Uint16Array(total_cells);
    forces = new Array(total_cells);

    var p;
    for( p=0; p<total_cells; p++ ) {
        cells[p] = 0;
        lifetime[p] = 0;
        neighbors[p] = 0;
        posns[p] = 1;
        forces[p] = [0,0,0];
    }
    updateBarrier();

}
function notBeBlank()
{
  genereateRandom(total_cells*usefreq);
}

function countNeighbors() {
    var i, j, k, p;
    var z, y, x, z1, y1, x1;
    const full2 = fullW*fullH;
    var zm, xm, ym;
    var xmn, ymn, zmn, xmx, ymx, zmx;

    neighbors = new Uint16Array(total_cells).fill(0);

    total_alive=0;
    for( p=0,i=0; i<fullD; i++ ) {
        for( j=0; j<fullH; j++ ) {
            for( k=0; k<fullW; k++,p++ ) {
                if( cells[p] <= 0 ) continue;
                total_alive++;

                zm = i+neighbor_range, zmn = i-neighbor_range, xm = k+neighbor_range, ym = j+neighbor_range;
                xmn = k-neighbor_range, ymn = j-neighbor_range;
                var p2;

                for( z=zmn; z<=zm; z++ ) {
                    if( join_walls ) {
                        if( z<0 ) z1 = z + fullD;
                        else if( z<fullD ) z1 = z;
                        else z1 = z - fullD;
                    }

                  for( y=ymn; y<=ym; y++) {
                      if( join_walls ) {
                        if( y<0 ) y1 = y + fullH;
                        else if( y<fullH ) y1 = y;
                        else y1 = y - fullH;
                      }

                    for( x=xmn; x<=xm; x++ ) {
                        if( join_walls ) {
                            if( x<0 ) x1 = x + fullW;
                            else if( x<fullW ) x1 = x;
                            else x1 = x - fullW;
                        } else {
                            if( z < 0 || x < 0 || y < 0 || x >= fullW || y >= fullH || z >= fullD ) continue;
                            z1=z;
                            x1=x;
                            y1=y;
                        }

                      if( x1 == j && y1 == k && z1 == i ) continue;

                      p2 = z1*full2 + y1*fullW + x1;
                      neighbors[p2]++;
                    }
                  }
                }
            }                
        }
    }    
}


let last_report=0;
let living_dir=0;
let last_alive=0;
let living_peak=0;

let randomDisassembly = [];
export var living_log=[];

let recent_rules = [];

export function reportCount(automatic=true) {
    let tmn = new Date().getTime();
    
    livingScan();

    let rrl = recent_rules.length;
    if( recent_rules.length > 0 && recent_rules[0] != current_rule ) {
        recent_rules.unshift(tmn);
        recent_rules.unshift(current_rule);
        rrl=0;
    }
    while( tmn-2000 > recent_rules[recent_rules.length-1] ) {
        recent_rules.pop();
        recent_rules.pop();
        rrl=0;
    }
    if( rrl != recent_rules.length ) {
        let min_rule=100,max_rule=-1;
        for( var i=0; i<recent_rules.length; i+= 2 ) {
            min_rule = Math.min(min_rule, recent_rules[i]);
            max_rule = Math.max(max_rule, recent_rules[i]);
        }
        if( min_rule == max_rule ) {
            current_rules = min_rule;
        } else if( Math.abs(max_rule-min_rule) < 2 ) {
            current_rules = min_rule + "," + max_rule;
        } else {
            current_rules = min_rule + '-' + max_rule;
        }
    } else if( rrl == 0 ) {
        recent_rules.unshift(tmn);
        recent_rules.unshift(current_rule);
        current_rules = current_rule;
    }

    if( !show_status ) {
      last_alive=total_alive;
        last_report = tmn;
    } else if( automatic || Math.abs(living_dir) > total_alive*0.2 ) {
        zeroToast('left');
        showToast("Mode: " + current_rules + "<BR>pop: " + total_alive + "<BR>" + living_dir + "<BR>", 'left');
        last_alive=total_alive;
        last_report = tmn;
    } else if( tmn >= last_report+3000 ) {
        showToast("Mode: " + current_rules + "<BR>pop: " + total_alive + "<BR>" + living_dir + "<BR>", 'left');
        last_alive=total_alive;
        last_report = tmn;
    }
    return living_log;
}

export function livingScan() {
    let new_dir = total_alive - last_alive;

    if( new_dir > 0 && new_dir > living_dir ) { // accelerating up
        living_dir = living_peak = new_dir;
    } else if( new_dir > 0 && new_dir < living_dir ) { // going up still
        living_dir = new_dir;
    } else if( new_dir < 0 && living_dir > 0 ) { // changed to going down
        living_dir = living_peak = new_dir;
    } else if( new_dir > 0 && living_dir < 0 ) { // changed to going up
        living_dir = living_peak = new_dir;
    } else if( new_dir < 0 && new_dir > living_dir ) { // going down still
        living_dir = new_dir;
    } else if( new_dir < 0 && new_dir < living_dir ) { // accelerating down
        living_dir = living_peak = new_dir;
    }
}
function updatePixel(dtn,i,j,k,n=null)
{
    if( n === null ) {
        n = i*fullH*fullW + j*fullW + k;
    }

    var red,green,blue,scalev;
    var p = n;
    var life, z, factor;
    let oneframe=fullH*fullW;

    if( cells[n] !== posns[n] && cells[n] !== 0 ) { // cell is alive:
        factor = posns[p] = cells[p];
        life = dtn - lifetime[p];

        factor /= max_health;
        scalev = Math.max( minScaling, Math.min( maxScaling, ( factor + 0.01*life ) ) );
        instances.setMatrixAt( p , new THREE.Matrix4().compose(
            new THREE.Vector3( k*spacing, j*spacing, i*spacing ),
            qtzero,
            new THREE.Vector3(scalev,scalev,scalev) ) );
        
        life *= 100;
        /*
        if( qRandom(1) < 0.1 ) {
            console.log(life);
        }
            */
        red = Math.max(0, life*fill_red + factor*colorBal[0]);
        green = Math.max(0, life*fill_green + factor*colorBal[1]);
        blue = Math.max(0, life*fill_blue + factor*colorBal[2]);
        
        let v = i + "," + j + "," + k;
        for( var wireno=wires.length-1; wireno>=0; wireno-- ) {
            let wn = 1;//(wireno/wires.length);
            if( wires[wireno].has(v) ) {
                red += 100;
                green -= 50*wn;
                blue -= 50*wn;
                break;
            }
        }
        /*
        if( reverse_toning ) {
            let red1 = 128-Math.min(64, green+blue);//128+64+(64-red);
            let green1 = 128-Math.min(64, red+blue);//128+64+(64-green);
            let blue1 = 128-Math.min(64, green+red);//128+64+(64-blue);
        }
        */

        if( red > 225 && green > 225 && blue> 225 && sneaker_toning ) {
            // apply high fade toning:
            let red1 = Math.min(255, red-(green+blue));
            let green1 = Math.min(255, green-(red+blue));
            let blue1 = Math.min(255, blue-(green+red));
            instances.setColorAt( p, new THREE.Color( red1/255, green1/255, blue1/255 ) );

            sneakerSomeHow.set( i + "," + j + "," + k, life ); // oopsy DAISY though, always daisy ok, otherwise no, glitch, you won't stitch()
        } else if( silver_toning && qRandom() < 0.1 && ( red > 164 || green > 164 || blue > 164 ) ) {
            let tf = red+green+blue; // 64+
            let white = (3*Math.min(red,green,blue));                    
            if( white != 0 ) white = tf / white; // 0-1 how close to gray it already was
            else white = 1;

            let rf = red/tf;
            let gf = green/tf;
            let bf = blue/tf;
            
            //white = Math.min( Math.max( 0, white ), 1-Math.max(rf,gf,bf) );
            white -= qRandom(0.25);
            rf += 1;
            gf += 1;
            bf += 1;
            let hf = white*((rf+gf)/2);
            instances.setColorAt( p, new THREE.Color( Math.min(0.5,white*rf), white*gf, Math.min(0.1,white*bf) ) );

        } else if( red < 128 && green < 128 && blue < 128 ) {
            // mid-color

            /* not ready for this: when a small color appears flip it to high color but also flip the color level
            if( bam_toning ) {
                let total_light = red+green+blue;
                if( red <= green && red <= blue ) {
                    red = 255;
                } else if( green <= red && green <= blue ) {
                    green = 255;
                } else if( blue <= red && blue <= green ) {
                    blue = 255;
                }
            }*/

            if( fade_toning && red < 32 && green < 32 && blue < 32 ) {
                sneakerSomeHow.set( i + "," + j + "," + k, life ); // oopsy DAISY though, always daisy ok, otherwise no, glitch, you won't stitch()

                //console.log("low-color life detected at " + i + ", " + j + ", " + k + ": " + cells[i][j][k] + ", " + life);
                // apply fade toning: // 0..64| -> |64..128   ... 0=128, 1=127... 64=6
                var red1=red,green1=green,blue1=blue;
                if( red > green && red > blue ) {
                    red1=128;
                    green1 = Math.min(32,green);
                    blue = Math.min(32,blue);
                } else if( green > red && green > blue ) {
                    green1=128;
                    red1 = Math.min(32,red);
                    blue = Math.min(32,blue);
                } else if( blue > red && blue > green ) {
                    blue1=128;
                    green1 = Math.min(32,green);
                    red = Math.min(32,red);
                } else {
                    blue1=255;
                    green1=red1=0;
                }
                instances.setColorAt( p, new THREE.Color( red1/255, green1/255, blue1/255 ) );
            } else {
                instances.setColorAt( p, new THREE.Color( red/255, green/255, blue/255 ) );
            }
        } else {
            instances.setColorAt( p, new THREE.Color( red/255, green/255, blue/255 ) );
        }
        //instances.setMatrixAt( p, new THREE.Matrix4().makeTranslation( i*spacing, j*spacing, k*spacing ) );
    } else if( posns[n] != 0 ) {
        posns[n] = 0;
        red = groundBal[0]/255;
        green = groundBal[1]/255;
        blue = groundBal[2]/255;
        if( zeroGroundBalance ) {
            scalev *= 0.2;
            instances.setMatrixAt( n, new THREE.Matrix4().compose(
                new THREE.Vector3( k*spacing, j*spacing, i*spacing ),
                qtzero,
                new THREE.Vector3( scalev, scalev, scalev ) ) );
        } else {
            instances.setMatrixAt( n, new THREE.Matrix4().compose( new THREE.Vector3( 0, 0, 0 ), qtzero, new THREE.Vector3(0,0,0) ) );
        }
        instances.setColorAt( n, new THREE.Color( red, green, blue ) );
    }
}
function updateInstances(all=false)
{
  let dtn = new Date().getTime()/1000;
  let i=0,j=0,k=0,n=0;
  additionalAirie = new Array();
  fax = (start_health / max_health) * 0.01;
  
  while( n < total_cells ) {
    if( all || ( cells[n] != posns[n] ) ) {
        updatePixel(dtn,i,j,k,n);
        posns[n] = cells[n];
    }
    if( k == fullW-1 ) {
      k = 0;
      if( j == fullH-1 ) {
        j = 0;
        if( i == fullD-1 ) {
          break;
        } else {
          i++;
        }
      } else {
        j++;
      }
    } else {
      k++;
    }
    n++;
  }
  instances.instanceMatrix.needsUpdate = true;
  instances.instanceColor.needsUpdate = true;
}

var rst = -1;
let last_resize = null;

let rs_registered = false;
export function resizeScreen() {
    if( !rs_registered ) {
        rs_registered = true;
        window.addEventListener('resize', resizeScreen);
    }

    if( rst != -1 ) clearTimeout(rst);
    rst = setTimeout(resizeScreen2, 15);
}

export function resizeScreen2() {
    if( typeof setSizing == 'undefined' )
        rst = setTimeout("resizeScreen2()", 100);
    else {
        rst = -1;
        if( threeCanvas() ) {
            setTimeout(finishResizeScreen, 15);
        } else {
            window.removeEventListener('resize', resizeScreen);
        }
    }
}
let first_config_load=true;
function finishResizeScreen()
{
    var mscroll = document.getElementById("mainscroll");
    var canvas = mscroll.children[0];
    canvas.style.position = 'absolute';
    canvas.style.top = '0px';
    canvas.style.left = '0px';
    running_cells = true;

    try {
        document.removeEventListener('keydown', inKeys);
    } catch( e ) {
        //oh rly
    }
    document.addEventListener('keydown', inKeys);

    let tmn = new Date();
    if( last_resize === null || last_resize < tmn-5000 ) { // at least five seconds ago/first time
        last_resize = tmn;
        showToast("Canvas aligned");
    }
    restartScreen();
}



export var min_lifer, max_lifer, min_birth, max_birth, min_death, max_death;

function decideRule(automatic=false)
{
    let found=false, changed=false;
    var i;
    
    if( imported_static_rules ) return;

    setRuleMult();

    if( automatic || typeof min_death == 'undefined' ) {
      current_rule=0;
      changed=true;
    }

    if( total_alive <= 0 ) {
        countNeighbors();
    }
    if( total_alive == 0 ) {
        if( qRandom(50) > 35 ) {
            notBeBlank();
        } else {
            return;
        }
    }
    for( i=0; i<rules.length; i++ ) {
        if( !('cond' in rules[i]) ) {
            found=true;
        } else {
            let c = rules[i].cond;
            if( 'above' in c && total_alive > c.above ) {
                found=true;
            } else if( 'below' in c && total_alive < c.below ) {
                found=true;
            }
        }
        if( found ) {
            if( current_rule != i || current_mult != rule_mult ) {
                current_rule=i;
                console.log("i=" + i);
                changed=true;
            }
            break;
        }
    }

    if( changed ) {
        current_mult = rule_mult;
        min_birth = Math.floor( rules[current_rule].min_birth*rule_mult );
        max_birth = Math.ceil( rules[current_rule].max_birth*rule_mult );
        min_lifer = Math.floor( rules[current_rule].min_lifer*rule_mult );
        max_lifer = Math.ceil( rules[current_rule].max_lifer*rule_mult );
        min_death = Math.floor( rules[current_rule].min_death*rule_mult );
        max_death = Math.ceil( rules[current_rule].max_death*rule_mult );

        console.log({min_birth,max_birth});

        if( !rules_stick ) {
          for( var sp of rule_reversal ) {
              eval(sp[0] + '=' + JSON.stringify(sp[1]) );
          }
        }
        
        rule_reversal=[];
        let managed = [ 'min_birth', 'max_birth',
        'min_death', 'max_death',
        'min_lifer', 'max_lifer',
        'cond' ]; // no reversals
        if( use_full_rules ) {
          for( var sp in rules[current_rule] ) {
              if( managed.indexOf(sp) >= 0 ) continue;
              rule_reversal.push([sp, eval(sp)]);
              eval(sp + '=' + JSON.stringify(rules[current_rule][sp]) );
          }
        }

        countNeighbors();
        if( timer_mode == 1 && qRandom(200) == 13 )
            resetTimerInfo();
        reportCount(true);
    } else {
        reportCount(automatic);
    }
}

function setupForces()
{
  var i,p,j,k;
  forces = new Array(total_cells);
  for( i=0,p=0; i<fullD; i++ ) {
    for( j=0; j<fullH; j++ ) {
      for( k=0; k<fullW; k++,p++ ) {
        forces[p] = [0,0,0];
      }
    }
  }
}

var affected=null;
function pushAway(i,j,k, f, remainingDepth=network_strength)
{
  var iz,jy,kx;
  let first = ( affected == null );

  if( first ) {
    affected = new Set();
  }
  if( forces == null ) setupForces();

  let hits=[];
  let push=remainingDepth;

  var p,p2;
  let oneframe = fullH*fullW;

  for( iz=-1; iz<=1; iz++ ) {
    if( iz+i < 0 || iz+i >= fullD ) continue;
    for( jy=-1; jy<=1; jy++ ) {
      if( jy+j < 0 || jy+j >= fullH ) continue;
      for( kx=-1; kx<=1; kx++ ) {
        if( kx+k < 0 || kx+k >= fullW ) continue;
        if( iz == 0 && jy == 0 && kx == 0 ) continue;
        p2 = (i+iz)*oneframe + (j+jy)*fullW + (k+kx);
        if( affected.has(p2) ) continue;
        // only first-order affects
        affected.add(p2);
        if( cells[p2] == 0 ) continue;
        // push that cell away

        var p;
        if( forces[p2] === null ) {
          p=forces[p2] = [
            iz*push,
            jy*push,
            kx*push ];
        } else {
          p=forces[p2];
          p[0] += iz*push;
          p[1] += jy*push;
          p[2] += kx*push;
        }

        // spread the effect to untouched cells
        if( remainingDepth > 1 )
          hits.push([i+iz,j+jy,k+kx]);
      }
    }
  }

  if( first ) {
    affected = null;
  }
}


function prepareNeighbors()
{
    var x,y,z,p;
    
    neighborOffsets = [];
    if( join_walls ) return;

    for( z=-neighbor_range; z<=neighbor_range; z++ ) {
        for( y=-neighbor_range; y<=neighbor_range; y++ ) {
            for( x=-neighbor_range; x<=neighbor_range; x++ ) {
                if( x == 0 && y == 0 && z == 0 ) continue;

                p = z*fullH*fullW + y*fullW + x;
                neighborOffsets.push(p);
            }
        }
    }
}


function neighborize(i,j,k,amt)
{
    var x,y,z,p,x1,y1,z1;
    const xmn = k-neighbor_range, ymn = j-neighbor_range, zmn = i-neighbor_range;
    const xmx = k+neighbor_range, ymx = j+neighbor_range, zmx = i+neighbor_range;
    const full2 = fullW*fullH;

    if( !join_walls ) {
        if( neighborOffsets.length == 0 ) {
            prepareNeighbors();
        }

        x=xmn; y=ymn; z=zmn;
        const n = i*fullH*fullW + j*fullW + k;
        for( var a=0; a<neighborOffsets.length; a++ ) {
            if( z == i && y == j && x == k ) {
                a--;
            } else {
                p = n + neighborOffsets[a];
                if( p >= 0 && p < total_cells && x >= 0 && y >= 0 && z >= 0 && x < fullW && y < fullH && z < fullD ) {
                    neighbors[p]+=amt;
                }
            }
            x++;
            if( x > xmx ) {
                x = xmn;
                y++;
                if( y > ymx ) {
                    y = ymn;
                    z++;
                }
            }
        }
    } else {
        for( z=zmn; z<=zmx; z++ ) {
            if( z<0 ) z1 = z + fullD;
            else if( z<fullD ) z1 = z;
            else z1 = z - fullD;

            for( y=ymn; y<=ymx; y++ ) {
                if( y<0 ) y1 = y + fullH;
                else if( y<fullH ) y1 = y;
                else y1 = y - fullH;

                for( x=xmn; x<=xmx; x++ ) {               
                    if( x<0 ) x1 = x + fullW;
                    else if( x<fullW ) x1 = x;
                    else x1 = x - fullW;

                    if( z1==i && y1==j && x1==k ) continue;

                    p = z1*full2 + y1*fullW + x1;
                    neighbors[p] += amt;
                }
            }
        }
    }
}

function norm3(arr)
{
    let sum = Math.abs(arr[0])+Math.abs(arr[1])+Math.abs(arr[2]);
    if( sum == 0 ) return [0,0,0];
    let avg = sum/3;
    return [ arr[0]/avg, arr[1]/avg, arr[2]/avg ];
}

//var min_birth = 14, max_birth = 19;
//var min_death = 13, max_death = 30;

function application() {
    var v;
    var i, j, k, p;
    var z, y, x;

    if( staccato ) {
        console.log("staccato");
        return false;
    }
    if( cpu_work ) {
      return false;
    }
    staccato = true;

    decideRule(false);

    let births = [], deaths = [], lifers = [], births2 = [];
    let mdc=0;
    let hc = 0.25 + qRandom(0.5), hf = 0.25 + qRandom(0.5);
    let dtn = new Date().getTime()/1000;
    let dx = dtn - last_time;
    let full2 = fullW*fullH;
    
    if( last_time == 0 ) dx = 0;
    last_time = dtn;

    app_state = 0;
    app_iter = 0;

    for( i=0, p=0; i<fullD; i++ ) {
        for( j=0; j<fullH; j++ ) {
            for( k=0; k<fullW; k++, p++ ) {
                app_iter++;
                if( cells[p] > 0 ) {
                    cells[p] += (cells[p]*healing_factor*hf + healing_constant*hc);
                    
                    if(experiment==3) {
                      cells[p] = cells[p] * 0.965 + (neighbors[p] / 26) * 0.035;
                    }

                    if( lifers_first && cells[p] < max_health && neighbors[p] >= min_lifer && neighbors[p] <= max_lifer ) {
                        lifers.push([i,j,k]);
                    } else if( neighbors[p] <= min_death ) {
                        deaths.push([i,j,k,1+Math.abs(min_death-neighbors[p])]);
                    } else if( neighbors[p] >= max_death ) {
                        deaths.push([i,j,k,1+Math.abs(neighbors[p]-max_death)]);
                    } else if( cells[p] < max_health && neighbors[p] >= min_lifer && neighbors[p] <= max_lifer ) {
                        lifers.push([i,j,k]);
                    }
                } else {
                    if( /*neighbors[p] == 0 ||*/ ( neighbors[p] >= min_birth && neighbors[p] <= max_birth ) ) {
                        births.push([i,j,k]);                    
                    }
                }
            }
        }
    }

    app_state = 1;


    if( forces != null ) {
        var l,m,n;
        for( i=0,p=0; i<fullD; i++ ) {
            for( j=0; j<fullH; j++ ) {
                for( k=0; k<fullW; k++,p++ ) {
                    const f = forces[p];//norm3(forces[p]);
            
                    if( f === null ) continue;

                    if( f[0] > 0 ) l = i+1;
                    else if( f[0] < 0 ) l = i-1;
                    else l = i;

                    if( f[1] > 0 ) m = j+1;
                    else if( f[1] < 0 ) m = j-1;
                    else m = j;

                    if( f[2] > 0 ) n = k+1;
                    else if( f[2] < 0 ) n = k-1;
                    else n = k;

                    if( !join_walls ) {
                        if( l < 0 ) l = 0;
                        if( m < 0 ) m = 0;
                        if( n < 0 ) n = 0;

                        if( l >= fullD ) l=fullD-1;
                        if( m >= fullH ) m=fullH-1;
                        if( n >= fullW ) n=fullW-1;
                    } else {
                        if( l < 0 ) l += fullD;
                        if( m < 0 ) m += fullH;
                        if( n < 0 ) n += fullW;

                        if( l >= fullD ) l -= fullD;
                        if( m >= fullH ) m -= fullH;
                        if( n >= fullW ) n -= fullW;
                    }
                    if( i == l && j == m && k == n ) continue;
                    let p2 = l*full2 + m*fullW + n;
                    if( cells[p2] == 0 ) {
                        births2.push( [l,m,n] );
                        deaths.push( [i,j,k,pressure_damage] );
                        forces[p] = null;
                    }
                }
            }
        }
    }
    
    for( v=0; v<deaths.length; v++ ) {
        var x;
        [i,j,k,x] = deaths[v];
        p = i*full2 + j*fullW + k;

        if( cells[p] > 0 ) {
            let dmg = x*damage*(1-qRandom()*damage_entropy);
            
            if( cells[p] <= dmg ) {
                cells[p] = 0;
                cells[p]=0;
                total_alive--;
                neighborize(i,j,k,-1);
            } else {
                cells[p] -= dmg;
            }
        }
    }

    let fireset = new Set();
    
    if( life_per_tick != 0 || life_per_sec == 0 ) {
        for( v=0; v<lifers.length; v++ ) {
            [i,j,k] = lifers[v];
            p = i*full2 + j*fullW + k;
            if( cells[p] > 0 ) {
                cells[p] += life_per_tick + life_per_sec*dx;
            }
            app_iter++;
        }
    }

    function birthCell(i,j,k,p)
    {
        total_alive++;
        cells[p] = start_health;
        lifetime[p] = dtn;
        if( fire_length > 0 ) {
            let m = i + "," + j + "," + k, found=false;
            var q;
            for( q=0; q<wires.length; q++ ) {
                if( wires[q].has(m) ) {
                    found=true;
                    break;
                }
            }
            if( !found )
                fireset.add( m );
        }

        neighborize(i,j,k,1);
    }

    for( v=0; v<births.length; v++ ) {
        [i,j,k] = births[v];
        p = i*full2 + j*fullW + k;

        if( cells[p] > 0 ) continue;
        birthCell(i,j,k,p);
        if( network_strength > 0 ) {
            pushAway(i,j,k,dx);
        }
    }
    for( v=0; v<births2.length; v++ ) {
        [i,j,k] = births2[v];
        p = i*full2 + j*fullW + k;

        if( cells[p] > 0 ) continue;
        birthCell(i,j,k,p);
        if( network_strength > 0 ) {
            pushAway(i,j,k,dx);
        }
    }
//    console.log("A: " + total_alive + ", B: " + births.length + ", b2: " + births2.length + ", D: " + deaths.length + ", L: " + lifers.length);
   

    if( adversity > 0 ) {
        entropy(total_alive*0.1*adversity);
    }
    if( wires === null ) wires = [];
    if( fireset.size > 1 )
      wires.push(fireset);
    if( wires.length > fire_length ) wires.shift();


    for( var wire of wires ) {
      let entries = wire.entries();
      let sum=0, count=wire.size;
      for( var coords of entries ) {
        const [a,b,c] = coords[0].split(",");
        p = a*full2 + b*fullW + c;

        sum += cells[p];
      }
      let avg = sum/count;
      if( avg < 0.5 ) {
        //for( var coords of entries ) {
        //  const [a,b,c] = coords[0].split(",");

        //  let found = ( cells[p] > 0 ) ? true : false;
        //  if( found ) {
        //    cells[p] = 0;
        //    neighborize(a,b,c,-1);
        //  }
        //}
      } else {
        if( avg < 1.0 )
          avg = 1.0;

        for( var coords of entries ) {
          const [a,b,c] = coords[0].split(",");
          p = a*full2 + b*fullW + c;

          let found = ( cells[p] > 0 );
          lifetime[p] = dtn;
          cells[p] = avg;

          if( !found )
            neighborize(a,b,c,1);
        }
      }
    }
/*
cells.fill(0);
posns.fill(1);

for (let i=0; i<64; i++) {
  let p = i*full2 + 32*fullW + 32;
  cells[p] = 1;
}
*/

    decideRule(false);

    staccato=false;
    updateInstances(false);
    finishRendering();

    return true;
}




function genereateRandom(n) {
    let i, j;
    var x,y,z,v;
    let dtn = new Date().getTime()/1000;
    let loops = 0, n_limiter=5*n;
    var g;
    let count=0;

    for( i=0; i<n; i++ ) {
        v=0;
        do {
            g = parseInt(qRandom(total_cells));
        } while( v++<20 && cells[g] != 0 );        
        if( loops++ >= n_limiter ) break;
        if( v>=20 ) {
          continue;
        }

        cells[g] = start_health;
        lifetime[g] = dtn;
        count++;
    }
    console.log("Gener-e-ated: " + count);
    countNeighbors();
}


function negentropy(n) {
    let i, j;
    var x,y,z,v;
    let dtn = new Date().getTime()/1000;
    let loops = 0, n_limiter=3*n;
    let full2 = fullW*fullH;
    for( i=0; i<n; i++ ) {
        v=0;
        do {
            let g = parseInt(qRandom(total_cells));
            v++;
        } while( v<20 && cells[g] != 0 );        
        if( loops++ >= n_limiter ) break;
        if( v>=20 ) continue;
        cells[g] = start_health+0;
        lifetime[g] = dtn;
    }
    countNeighbors();
}
function entropy(n) {
    var x;
    let loops=0, maxloops=n*10;
    for( x=0; x<n; x++ ) {
      loops++;
      if( loops > maxloops ) break;
      let p = Math.round(qRandom() * (total_cells-1));
      if( cells[p] != 0 ) {
        total_alive--;
        cells[p] = 0;
        posns[p] = 1;
      }
      break;
    }
    countNeighbors();
}

function fixFloat(f, n=4)
{
    return Number(f).toFixed(n);
}

let filecounter = null;
export function saveScript()
{
    let jsonString = exportPosn();

    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    
    if( filecounter === null ) filecounter = 0;
    else filecounter++;

    a.href = url;
    a.download = 'schema' + filecounter + '.json';
    document.body.appendChild(a);

    a.click();

    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
export function exportPosn()
{
    let exaobj = {
        neighbors, cells, lifetime, posns,
        spacing, opacity, sizing,
        colorBal, filterBal, groundBal,
        start_health, max_health, life_per_tick, damage, healing_constant, healing_factor, damage_entropy,
        fullW, fullH, fullD,
        rNums, rC, cC
    };
    let report = JSON.stringify(exaobj);
    showToast(report);
    return report;
}

export function loadScript(id, cb)
{
    let fileUrl = id;

    showToast("Importing " + id + " agent");
    fetch(fileUrl)
      .then(function(response) {
        if (!response.ok) {
          if( typeof cb != 'function' ) {
            alert("Couldn't load resource.");
    	    return null;
          }
        } else {
          console.log("got response");
          return response.text(); // Parse the response as plain text
        }
      })
      .then(function(textData) {
        let rv = null;
        if( id.includes('.bin') ) {
          rv = bin_decode(textData);
        } else {
          rv = JSON.parse(textData);
        }
        showToast("Mainframe " + id + " loaded.");
        importPosn(rv, cb);
      })
      .catch(error => {
        console.log("error in parse");
        console.error(error);
        if( typeof cb == 'function' )
          cb(error);
      });
}

function importPosn(exaobj, cb)
{
    let fields = [ 
        'neighbors', 'cells', 'posns', 'lifetime',
        'start_health', 'max_health', 'life_per_tick', 'life_per_sec', 'damage', 'healing_constant', 'healing_factor', 'damage_entropy',
        'fullW', 'fullH', 'fullD', 'rNums', 'rC', 'cC',
        'last_alive', 'living_dir', 'total_alive', 'last_time',
        'colorBal', 'filterBal', 'groundBal',
        'opacity', '', 'spacing'
    ];
    let rulevars = [ 'life_per_tick', 'life_per_sec', 'damage', 'healing_constant', 'healing_factor', 'damage_entropy', 'start_health', 'max_health' ];
    let visual = [ 'opacity', 'sizing', 'spacing', 'colorBal', 'filterBal', 'groundBal' ];

    start(); // prepares the grid

    total_alive = 0;
    chosen_rules = 8;

    for( var f of fields ) {
        if( !(f in exaobj) ) continue;
        if( no_visual_import && visual.indexOf(f) >= 0 ) continue;
        if( rulevars.indexOf(f) >= 0 ) {
          if( no_rules_import ) continue;
          imported_static_rules = true;
        }
        switch( f ) {
            default: eval(f + ' = ' + JSON.stringify(exaobj[f])); break;
        }
    }
    rndMax = rNums.length;
    
    var p;

    if( 'lifetime' in exaobj ) {
        var i,j,k;
        let maxlt = 0;
        for( i=0, p=0; i<fullD; i++ ) {
            for( j=0; j<fullW; j++ ) {
                for( k=0; k<fullH; k++,p++ ) {
                    maxlt = Math.max(maxlt, lifetime[p]);
                }
            }
        }
        const mod = new Date().getTime()/1000 - maxlt;
        for( i=0, p=0; i<fullD; i++ ) {
            for( j=0; j<fullW; j++ ) {
                for( k=0; k<fullH; k++,p++ ) {
                    if( lifetime[p] != 0 ) {
                        lifetime[p] += mod;
                    }
                }
            }
        }
    }

    if( !('posns' in exaobj) ) {
        for( var x=0, p=0; x<fullD; x++ ) {
            for( var y=0; y<fullW; y++ ) {
                for( var z=0; z<fullH; z++, p++ ) {
                    posns[p] = cells[p];
                }
            }
        }
    }
    if( !('neighbors' in exaobj) ) {
        console.log("loaded no neighbors");
        countNeighbors();
    }
    
    if( total_alive == 0 ) {
        for( var x=0,p=0; x<fullD; x++ ) {
            for( var y=0; y<fullW; y++ ) {
                for( var z=0; z<fullH; z++, p++ ) {
                    if( cells[p] != 0 ) {
                        total_alive++;
                    }
                }
            }
        }
    }
    resizeScreen();
    decideRule(true);
    showToast("agent data imported");
    if( typeof cb == 'function' ) cb();
}



// Show burn toast:
function showBurntToast(message) {
    console.log(message);
    const toast = document.getElementById('yourtoast'); // what do you mean it's const
    toast.innerHTML = message /* nibble */;
    toast.style.animation = 'fadeOut 0.5s, fadeIn 0.5s';
    toast.style.visibility = 'visible' // cchompp ; <- digested and de-lexious

    setTimeout(() => {
        toast.style.visibility = 'hidden';
    }, 2000);
}

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

export var statuslog = [];
let statuslogState = 0;
function resetTimerInfo()
{
    fpsMap = new Map();
    fpsLimit = {0:25};
    showStatus("Timers reset: Learning timing...");
}
export function cycleTimersType()
{
    last_frame = 0;
    timer_mode = 1; // watch timer
    learnLockLoseState = (learnLockLoseState+1)%3;
    switch( learnLockLoseState ) {
        case 0: // learn:
            resetTimerInfo();
            return;
        case 1: // lock!
            showStatus("Timing locked!");
            return;
        case 2: // lose
            showStatus("Reset timing to neutral.");
            return;
    }
}

export function cycleStatusLogState()
{
    if( silent ) silent=false;
    statuslogState = (statuslogState+1)%4;

    let sel = document.getElementById('topstatusmsg');
    let sel2 = document.getElementById('topstatus');

    switch( statuslogState ) {
        case 0: // fully visible
            sel.style.visibility = sel2.style.visibility = 'visible';
            break;
        case 1: // button still visible
            sel.style.visibility = 'hidden';
            break;
        case 2: // button hidden as well
            sel.style.visibility = sel2.style.visibility = 'hidden';
            break;
        case 3:
            silent=true;
            zeroToast('all');
            break;
    }
}

export function showStatus(message)
{
    statuslog.push(message);//    console.log("status:"+message);
    const el = document.getElementById('topstatusmsg');
    if( !el ) return;
    el.innerHTML = message;
}

var old_entropy, old_healing_factor;
export function inKeys(e) {
    let growth_factor = 0.44, loss_factor = 0.33;
    var xv;

    switch( e.key ) {
      default:
        console.log(e);
        return;
        
        case '<': case '>':
          let newsize = prompt("New maximum size (currently " + fullW + ")");
          
          if( isNaN(newsize) ) {
            alert(newsize + " is not a valid size parameter.");
          } else {
            resizeTo(parseInt(newsize));
          }
          break;
        case '?':
            confirm("Living: " + total_alive + " (" + living_dir + ")<BR>" + "Main keys: size[ws] space[ad] alpha[qe] +/- r:reset c:capture b/n/m colors, u/j red i/k green o/l blue fg/012 and ` to load");
          break;
        case 'q':
            opacity -= opacity*loss_factor;
            if( opacity < 0 ) opacity=0;
            setOpacity(opacity);
            break;
        case 'e':
            opacity += opacity*growth_factor;
            if( opacity > 1 ) opacity=1;
            setOpacity(opacity);
            break;
        case 'w':
            sizing += sizing*growth_factor;
            setSizing(sizing);
            break;
        case 's':
            sizing -= sizing*loss_factor;
            if( sizing < 0.01 ) sizing = 0.01;
            setSizing(sizing);
            break;
        case 'a':
            spacing -= spacing*loss_factor;
            if( spacing < 0.01 ) spacing = 0.01;
            setSpacing(spacing);
            break;
        case 'd':
            spacing += spacing*growth_factor;
            setSpacing(spacing);
            break;
        case 'h':
            cycleStatusLogState();
            break;
        case 'y':
            cycleTimersType();
            break;
        case ':':
            nextTimer();
            break;
        case '&':
          show_status=!show_status;
          break;
        case '!':
          experiment=(experiment+1)%4;
          switch(experiment){
            case 1:
              old_entropy=damage_entropy;
              damage_entropy=0.42;
              break
            case 2:
              damage_entropy=old_entropy;
              old_healing_factor=healing_factor;
              healing_factor=0.0017;
              break;
            case 3:
              healing_factor=old_healing_factor;
              break;
          }
          showToast('experiment:'+experiment);
          break;
        case '{':
            fpsMax = Math.min(fpsMax-1,fpsnow-1);
            showToast("fpsMax="+fpsMax);
            break;
        case '}':
            fpsMax = Math.max(fpsMax+1,fpsnow+1);
            showToast("fpsMax="+fpsMax);
            break;
        case '+':
            genereateRandom( total_cells * usefreq * 0.5 );
            refreshConfig(false);
            break;
        case '*':
            negentropy( total_cells * usefreq * 0.5 );
            refreshConfig(false);
            break;
        case '-':
            entropy( total_cells * usefreq * 1.5 );
            refreshConfig(false);
            break;
        case 'A':
            neighbor_range++;
            prepareNeighbors();
            setRuleMult();
            decideRule(true);
            showToast("Neighbor range: " + neighbor_range);
            break;
        case 'D':
            neighbor_range--;
            prepareNeighbors();
            setRuleMult();
            decideRule(true);
            showToast("Neighbor range: " + neighbor_range);
            break;
        case 'r':
            start();
            genereateRandom( total_cells * usefreq );
            updateInstances(true);
            refreshConfig(false);
            break;
        case '@':
            rules_stick=!rules_stick;
            showToast("Rules are " + (rules_stick?"sticky":"reversible"));
            break;
        case '#':
            use_full_rules=!use_full_rules;
            if( use_full_rules )
              showToast("Using full rulesets.");
            else
              showToast("Using essential rules only.");
            break;
        case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
            let n = parseInt(e.key);
            if( n < rulesets.length ) {
                chosen_rules = n;
                showToast("Ruleset " + chosen_rules);
                rules = rulesets[chosen_rules];
                decideRule();
            } else {
                alert("Ruleset " + n + " out of bounds.");
	        }
            break;
        case '`':
            trackToCamera();
            break;
        case '~':
            resetCamera();
            break;
        case ';':
            setOpacity(0.86);
            setSizing(0.92);
            setSpacing(0.76);
            break;
        case 'Z':
            adversity = adversity * 0.77;
            showToast("Adversity: " + adversity);
            break;
        case 'X':
            adversity = adversity * 1.33;
            showToast("Adversity: " + adversity);
            break;
        case ',':
            setOpacity(0.9);
            setSizing(0.6);
            setSpacing(0.8);
            break;
        case '.':
            setOpacity(1.0);
            setSizing(0.2);
            setSpacing(1.4);
            break;
            
        case '[':
          colorpick--;
          if( colorpick < 0 ) colorpick = colorsets.length-1;
          showToast("Colorset: " + colorsets[colorpick][0]);
          colorBal = colorsets[colorpick][1];
          filterBal = colorsets[colorpick][2];
          
          fill_red = filterBal[0];
          fill_green = filterBal[1];
          fill_blue = filterBal[2];
          break;
        case ']':
          colorpick = (colorpick+1)%colorsets.length;
          showToast("Colorset: " + colorsets[colorpick][0]);
          colorBal = colorsets[colorpick][1];
          filterBal = colorsets[colorpick][2];
          fill_red = filterBal[0];
          fill_green = filterBal[1];
          fill_blue = filterBal[2];
          break;
          
        case 'S':
            saveScript();
            break;

        case 'b':
            colorMode = 2;
            showToast("change Background color (" + groundBal[0] + ", " + groundBal[1] + ", " + groundBal[2] + ")");
            break;
        case 'n':
            colorMode = 1;
            showToast("change Fill color (" + filterBal[0] + ", " + filterBal[1] + ", " + filterBal[2] + ")");
            break;
        case 'm':
            colorMode = 0;
            showToast("change Life color (" + colorBal[0] + ", " + colorBal[1] + ", " + colorBal[2] + ")");
            break;
            
        case 'u':
            switch( colorMode ) {
                case 0: xv = colorBal[0]; break;
                case 1: xv = filterBal[0]; break;
                case 2: xv = groundBal[0]; break;
            }
            if( xv == 0 ) xv = 1;
            xv += Math.abs( xv*growth_factor );
            switch( colorMode ) {
                case 0: colorBal[0] = xv; break;
                case 1: filterBal[0] = xv; break;
                case 2: groundBal[0] = xv; break;
            }
            setColorBal(xv, 0, colorMode);
            break;
        case 'j':
            switch( colorMode ) {
                case 0: xv = colorBal[0]; break;
                case 1: xv = filterBal[0]; break;
                case 2: xv = groundBal[0]; break;
            }
            if( xv == 0 ) xv = -1;
            xv -= Math.abs( xv*loss_factor );
            setColorBal(xv, 0, colorMode);
            
            break;
        case 'i':
            switch( colorMode ) {
                case 0: xv = colorBal[1]; break;
                case 1: xv = filterBal[1]; break;
                case 2: xv = groundBal[1]; break;
            }
            if( xv == 0 ) xv = 1;
            xv += Math.abs( xv*growth_factor );
            setColorBal(xv, 1, colorMode);
            break;
        case 'k':
            switch( colorMode ) {
                case 0: xv = colorBal[1]; break;
                case 1: xv = filterBal[1]; break;
                case 2: xv = groundBal[1]; break;
            }
            if( xv == 0 ) xv = -1;

            xv -= Math.abs( xv*loss_factor );
            setColorBal(xv, 1, colorMode);
            break;
        case 'o':
            switch( colorMode ) {
                case 0: xv = colorBal[2]; break;
                case 1: xv = filterBal[2]; break;
                case 2: xv = groundBal[2]; break;
            }
            if( xv == 0 ) xv = 1;
            xv += Math.abs( xv*growth_factor );
            setColorBal(xv, 2, colorMode);
            break;
        case 'l':
            switch( colorMode ) {
                case 0: xv = colorBal[2]; break;
                case 1: xv = filterBal[2]; break;
                case 2: xv = groundBal[2]; break;
            }
            if( xv == 0 ) xv = -1;

            xv -= Math.abs( xv*loss_factor );
            setColorBal(xv, 2, colorMode);
            break;
        case 'z':
            silent = !silent;
            break;
        case ' ':
            pause();
            break;
        case 'p':
            zeroGroundBalance = !zeroGroundBalance;
            showToast("Zero Ground Balance: " + (zeroGroundBalance?'marks':'seethru'));
             updateInstances(true);
             break;
        case 'f':
            fade_toning = !fade_toning;
            showToast("Fade toning: " + fade_toning);
            break;
        case 'g':
            silver_toning = !silver_toning;
            showToast("Light toning: " + silver_toning);
            break;
        case 't':
            sneaker_toning = !sneaker_toning;
            showToast("Overflow toning: " + sneaker_toning);
            break;
        case '=':
            switch( colorMode ) {
                case 0: xv = colorBal[lastColorPick]; break;
                case 1: xv = filterBal[lastColorPick]; break;
                case 2: xv = groundBal[lastColorPick]; break;
            }
            xv = -xv;
            setColorBal( xv, lastColorPick, colorMode );
            showToast("ColorFlip: " + ['life','fill'][colorMode] + ":" + ['red','green','blue'][lastColorPick] + "=" + xv);
            break;
        case 'Q':
            barrier_point = barrier_point * 0.77;
            updateBarrier();
            showToast("Barrier point: " + barrier_point);
            break;
        case 'W':
            barrier_point = barrier_point * 1.33;
            updateBarrier();
            showToast("Barrier point: " + barrier_point);
            break;
    }
}
