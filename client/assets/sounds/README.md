# Sonidos

Este juego espera estos 3 archivos en esta carpeta (no incluidos — agregalos vos):

- `run.ogg` — trote en bucle, sin balón. El pitch (playbackRate) sube y baja en vivo según la velocidad real del jugador, hasta sprint.
- `ballrun.ogg` — mismo comportamiento, pero mientras se conduce el balón.
- `shot.ogg` — one-shot al patear (cualquier jugador, no solo el local).

Si faltan, el juego funciona igual — `SoundManager` (`client/src/audio/SoundManager.js`) falla en silencio (`.catch(() => {})`) y simplemente no suena hasta que estén.
