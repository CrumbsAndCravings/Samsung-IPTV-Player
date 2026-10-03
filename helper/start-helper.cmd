@echo off
rem Starts the ARAN+ helper, which converts videos the TV cannot play.
rem Leave the window open while you watch.
title ARAN+ helper
cd /d "%~dp0.."
node helper\aranplus-helper.mjs
pause
