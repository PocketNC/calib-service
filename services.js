const util = require("util");
const { exec } = require("child_process");
const execPromise = util.promisify(exec);

const UNKNOWN = "unknown";

async function getServiceStatus() {
  const [ pocketncStatus, rockhopperStatus ] = await Promise.all([ execPromise("systemctl status PocketNC"),
                                                                   execPromise("systemctl status Rockhopper") ]);
  const {
    stdout: pocketncStdout
  } = pocketncStatus;

  const {
    stdout: rockhopperStdout
  } = rockhopperStatus;

  const pocketncLines = pocketncStdout.trim().split('\n').map((str) => str.trim());
  const rockhopperLines = rockhopperStdout.trim().split('\n').map((str) => str.trim());

  const pocketnc = pocketncLines.find((line) => line.startsWith("Active")).split(" ")[1] || UNKNOWN;
  const rockhopper = pocketncLines.find((line) => line.startsWith("Active")).split(" ")[1] || UNKNOWN;

  return { pocketnc, rockhopper };
}

async function shutdownServices() {
  await Promise.all([ execPromise("sudo systemctl stop PocketNC"),
		      execPromise("sudo systemctl stop Rockhopper") ]);

  return { shutdown: true };
}


module.exports = {
  getServiceStatus,
  shutdownServices
};
