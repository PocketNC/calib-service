#!/bin/bash

cd /opt/calib-service

# pass CalibService as argument on command line so we
# can grep for it when looking for a process id to
# kill with stopCalib.sh
nohup node index.js $1 CalibService > /dev/null 2>&1 &
