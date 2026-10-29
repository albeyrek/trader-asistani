@echo off
rem Trader Asistani - YEREL GELISTIRME
rem Normal kullanimda gerek yok: veri GitHub'da her gun guncellenir, haber bekcisi Cloudflare'de calisir.
rem Bu dosya sadece bilgisayarda deneme yapmak icin yerel API'yi baslatir
rem (uygulamada Ayarlar > Veri kaynagi > "Yerel bilgisayar" secilmeli).
rem
rem   baslat.bat          yerel API
rem   baslat.bat expo     yerel API + Expo gelistirme sunucusu
rem
rem Yerel haber bekcisi (python -m scanner.watch) bulut bekcisiyle birlikte calisirsa bildirimler iki kez gelir.

start "Trader API (kapatma)" cmd /k "cd /d "%~dp0backend" && .venv\Scripts\python.exe -m uvicorn api.main:app --host 0.0.0.0 --port 8000"
if /i "%1"=="expo" start "Trader Mobil (kapatma)" cmd /k "cd /d "%~dp0mobile" && npx expo start"
