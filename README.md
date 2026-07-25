# ⚽ Sokkaio

Juego de fútbol **4v4 online** en tercera persona, hecho con **Three.js**,
HTML, CSS y JS puro (sin build step) + **Node.js / Socket.IO**.

Entrás con un nickname y ya estás en la partida.

## Controles

| Entrada | Acción |
|---|---|
| `WASD` | Moverse (relativo a la cámara, con strafe lateral) |
| `Mouse` | Cámara 360° (no rota al personaje si está quieto) |
| `Shift` | Sprint (stamina, recarga completa en ~5 s) |
| `Espacio` | Salto |
| `Clic izquierdo (mantener)` | Cargar remate: barra de poder + línea de dirección según la cámara; se dispara al soltar (sin cooldown) |
| `Clic ruedita` | Cruzar pie (sin cooldown) — controla/roba el balón dentro del círculo bajo tus pies, en cualquier ángulo |
| `Clic derecho` | Barrida |

> Cruzar pie: si la pelota está dentro del **círculo de control** que ves
> en la base de tu personaje, te la quedás — podés spamear el botón o
> tocarlo justo cuando llega. Barrida: **no controla** — si tu pie conecta
> la pelota del rival, se la **quita** (queda suelta); si contactás al
> **rival** (pie o cuerpo), es **falta** (3 s aturdido). Mientras barrés,
> tu cuerpo tendido bloquea el balón libre (rebota, no te atraviesa).
> El balón libre no se pega solo: si no cruzás el pie, te atraviesa como
> si pasara entre las piernas.
>
> Remate: un toque suelto adelanta la pelota ~1 m, media barra ~2 m, y de
> ahí a barra llena crece hasta el cañonazo. Correr de espaldas es más
> lento que de frente.
>
> Si el balón toca tu **brazo** (entre hombro y mano) en cualquier
> momento —salto, barrida, lo que sea— es **mano**: falta automática.
>
> Sprintar agota la stamina; **no recarga mientras sigas apretando Shift**,
> aunque ya no puedas sprintar. Soltalo para que vuelva a cargar (más
> rápido si estás parado del todo).

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
