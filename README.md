# ⚽ Sokkaio

Juego de fútbol **4v4 online** en tercera persona, hecho con **Three.js**,
HTML, CSS y JS puro (sin build step) + **Node.js / Socket.IO**.

Entrás con un nickname y ya estás en la partida.

## Controles

| Entrada | Acción |
|---|---|
| `WASD` | Moverse (relativo a la cámara) |
| `Mouse` | Cámara 360° (no rota al personaje) |
| `Shift` | Sprint (stamina, recarga completa en ~5 s) |
| `Espacio` | Salto |
| `Clic izquierdo` | Patear (en dirección de la cámara) |
| `Clic ruedita` | Cruzar pie (robo defensivo corto) |
| `Clic derecho` | Barrida |

> Cruzar pie y barrida: si el pie conecta con la **pelota**, la robás.
> Si conecta con la **pierna del rival**, es **falta** (3 s aturdido).

## Correr en local

```bash
npm install
npm start
```

Abrí `http://localhost:3000` en varias pestañas para probar el multijugador.

## Despliegue en Render

El repo incluye [render.yaml](render.yaml): en Render, **New → Blueprint**,
apuntá al repositorio y listo. También funciona como Web Service manual:

- **Build command:** `npm install`
- **Start command:** `npm start`
- **Health check:** `/healthz`

## Arquitectura

Ver [ARCHITECTURE.md](ARCHITECTURE.md) — modelo de autoridad cliente/servidor,
colisiones por extremidad, interpolación de snapshots y optimizaciones.
