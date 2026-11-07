@echo off
rem Melody: open the music folder. Copy your audio files here (mp3, wav, flac, ogg, m4a).
rem Or attach a file to the /play command in Discord: the bot saves it here by itself.
cd /d "%~dp0"
if not exist "music" mkdir "music"
start "" explorer "%~dp0music"
