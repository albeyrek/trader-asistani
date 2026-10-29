@echo off
rem Trader Asistani: API sunucusunu ve haber bekcisini ayri pencerelerde baslatir.
rem Telefon, uygulama verisi icin bu bilgisayarla ayni Wi-Fi aginda olmali. Bildirimler her yerde gelir.
rem Gelistirme icin Expo sunucusu gerekiyorsa: baslat.bat expo

start "Trader API (kapatma)" cmd /k "cd /d "%~dp0backend" && .venv\Scripts\python.exe -m uvicorn api.main:app --host 0.0.0.0 --port 8000"
start "Trader Haber Bekcisi (kapatma)" cmd /k "cd /d "%~dp0backend" && .venv\Scripts\python.exe -m scanner.watch"
if /i "%1"=="expo" start "Trader Mobil (kapatma)" cmd /k "cd /d "%~dp0mobile" && npx expo start"
