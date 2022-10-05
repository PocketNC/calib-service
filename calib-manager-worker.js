const zmq = require("zeromq");

/*
CalibManagerWorker class provides an IPC link to the linuxcnc-python CalibManager via ZeroMQ (zmq)
*/
class CalibManagerWorker {
  constructor(
    calibProcess
  ) {
    this.calibProcess = calibProcess;

    this.calibSocket = zmq.socket("pull");

    this.calibSocket.on('connectFailed', (error) => {
      setTimeout(this.connect, 3000);
      console.log('Calib Connect Error: ' + error.toString());
    });

    this.calibSocket.on('connect', (connection) => {
      console.log('Calib Connection established!');
    });

    this.calibSocket.on("message", async (msg) => {
      console.log("Received ZMQ msg from Calib manager: %s", msg.toString());
      var calibManagerReport = JSON.parse(msg);
      await this.calibProcess.receiveUpdate(calibManagerReport);
    });
  }

  connect() {
    console.log('attempting connect calib')
    this.calibSocket.connect('ipc:///tmp/cmm');
  }
}

module.exports = {
  CalibManagerWorker
};
