const zmq = require("zeromq");

class CalibManagerWorker {
  constructor() {
    this.calibSocket = zmq.socket("pull");

    this.calibSocket.on('connectFailed', function(error) {
      setTimeout(this.connect, 3000);
      console.log('Calib Connect Error: ' + error.toString());
    });

    this.calibSocket.on('connect', function(connection) {
      console.log('Calib Connection established!');
    });

    this.calibSocket.on("message", async function(msg) {
      console.log("Received ZMQ msg from Calib manager: %s", msg.toString());
      var calibManagerReport = JSON.parse(msg);

      calibProcess.skipCmm = calibManagerReport.skip_cmm;
      calibProcess.status = calibManagerReport.status;
      calibProcess.bHomeErr = calibManagerReport.b_home_err;
      calibProcess.aHomeErr = calibManagerReport.a_home_err;

      if(calibManagerReport.why === MSG_WHY_STEP_COMPLETE){
        if(calibManagerReport.stage_completed){
          calibProcess.stages[calibProcess.currentMode][calibManagerReport.stage].completed = true;
        }
        if(calibManagerReport.state == STATE_IDLE){
          if(commandedState === STATE_RUN){
            await runCalib();
          }
          else if(commandedState === STATE_STEP){
            actualState = STATE_IDLE
          }
        }
        else{
          console.log('step completed but not advancing because not idle');
        }
      }
      else if(calibManagerReport.why === MSG_WHY_UPDATE){

      }
      else if(calibManagerReport.why === MSG_WHY_ERROR){
        calibProcess.stages[calibProcess.currentMode][calibProcess.currentStage].error = true;
        actualState = STATE_ERROR
      }
      else if(calibManagerReport.why === MSG_WHY_FAIL){
        calibProcess.stages[calibProcess.currentMode][calibProcess.currentStage].error = true;
        actualState = STATE_FAIL
      }

      const data = await getCalibStatus();
      if(uiConnection){
        uiConnection.send(JSON.stringify({ ['getCalibStatus']: data }));
      }
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
