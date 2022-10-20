#!/bin/bash

if [ -f /opt/pocketnc/pocketnc_env ]; then
  source /opt/pocketnc/pocketnc_env
fi
if [ -f /home/pocketnc/.pocketnc_env ]; then
  source /home/pocketnc/.pocketnc_env
fi

cd /opt/calib-service

# pass CalibService as argument on command line so we
# can grep for it when looking for a process id to
# kill with stopCalib.sh
nohup node index.js $1 CalibService >> /var/opt/pocketnc/calib/calib-service.log 2>&1 &
