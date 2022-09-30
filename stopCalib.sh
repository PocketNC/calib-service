#!/bin/bash

pgrep -f "CalibService" | while read -r pid ; do
  echo "Killing calib-service $pid"
  kill $pid
done
