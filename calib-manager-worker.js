const zmq = require("zeromq");

/*
CalibManagerWorker class provides an IPC link to the linuxcnc-python CalibManager via ZeroMQ (zmq)
*/
class CalibManagerWorker {
  constructor(
    calibProcess
  ) {
    this.connected = false;
    this.calibProcess = calibProcess;

    this.calibSocket = zmq.socket("pull");

    this.calibSocket.on('connectFailed', (error) => {
      this.connected = false;
      setTimeout(this.connect, 3000);
      console.log('Calib Connect Error: ' + error.toString());
    });

    this.calibSocket.on('connect', (connection) => {
      console.log('Calib Connection established!');
      this.connected = true;
    });

    this.calibSocket.on("message", async (msg) => {
      // console.log("Received ZMQ msg from Calib manager: %s", msg.toString());
      var calibManagerReport = JSON.parse(msg);
      await this.calibProcess.receiveUpdate(calibManagerReport);
    });

    this.calibSocket.on('close', (reasonCode, description) => {
      this.connected = false;
      console.log('Calib ZMQ connection closed: ' + description.toString());
    });
  }

  connect() {
    console.log('attempting connect calib')
    this.calibSocket.connect('ipc:///tmp/cmm');
    console.log('after connect calib')

  }
}

module.exports = {
  CalibManagerWorker
};
