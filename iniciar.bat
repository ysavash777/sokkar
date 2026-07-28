@echo off
cd /d "%~dp0"
echo Sokkaio - iniciando servidor...
echo.

if not exist "node_modules" (
    echo Instalando dependencias por primera vez, un momento...
    call npm install
    if errorlevel 1 (
        echo.
        echo Hubo un error instalando las dependencias.
        pause
        exit /b 1
    )
)

echo Servidor arrancando en http://localhost:3000
echo Deja esta ventana abierta mientras juegues. Cerrala para apagar el servidor.
echo.
call npm start

pause
