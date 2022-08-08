const util = require("util");
const zmq = require("zeromq");
const { exec } = require("child_process");
const execPromise = util.promisify(exec);

const UNKNOWN = "unknown";

async function getCalibStatus(a) {
  console.log(a)
  // var sock = zmq.socket("push");

  // sock.bindSync("tcp://127.0.0.1:5555");
  // console.log("Producer bound to port 5555");

  // sock.send("get_status");
}

async function loadCalibProgress() {
  // var sock = zmq.socket("push");

  // sock.bindSync("tcp://127.0.0.1:5555");
  // console.log("Producer bound to port 5555");

  // sock.send("load_progress");
}

async function runStep(step_string) {
  // var sock = zmq.socket("push");

  // sock.bindSync("tcp://127.0.0.1:5555");
  // console.log("Producer bound to port 5555");

  // sock.send(step_string);
}

module.exports = {
  getCalibStatus,
  loadCalibProgress,
  runStep,
};
