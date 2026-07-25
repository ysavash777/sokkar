# Arquitectura — Sokkaio

Juego de fútbol 4v4 online en tercera persona. Cliente Three.js sin build step,
servidor Node.js + Socket.IO autoritativo sobre el balón. Pensado para desplegarse
como un único servicio web en Render.

## Estructura de carpetas

```
sokkaio/
├── ARCHITECTURE.md          # Este documento
├── README.md                # Guía de uso y despliegue
├── package.json             # Un solo paquete (server sirve al client)
├── render.yaml              # Blueprint de despliegue en Render
├── shared/
│   └── constants.js         # Única fuente de verdad de gameplay/física (ESM,
│                            #   importado por el server y servido al browser)
├── server/
│   ├── index.js             # Express (estáticos + healthcheck) + Socket.IO
│   └── game/
│       ├── GameRoom.js      # Sala 4v4: posesión, robos, faltas, goles, snapshots
│       └── physics.js       # Física del balón + colisiones por extremidad
└── client/
    ├── index.html           # Import map (Three.js CDN), pantalla de nickname, HUD
    ├── css/style.css
    └── src/
        ├── main.js          # Bootstrap: renderer, escena, luces, loop
        ├── core/
        │   ├── InputManager.js     # Teclado/mouse + pointer lock
        │   └── CameraController.js # Cámara orbital 360°
        ├── entities/
        │   ├── SteveCharacter.js   # Personaje por extremidades + animación procedural
        │   ├── Ball.js             # Balón (render + rodadura visual)
        │   └── Pitch.js            # Cancha, líneas, arcos (solo colores)
        ├── game/
        │   └── GameClient.js       # Predicción local + interpolación remota
        ├── net/
        │   └── NetworkClient.js    # Socket.IO + buffer de snapshots
        └── ui/
            └── HUD.js              # Marcador, stamina, mensajes
```

## Modelo de autoridad (red)

| Aspecto | Autoridad | Motivo |
|---|---|---|
| Movimiento del propio jugador | **Cliente** (con clamps en server) | Respuesta inmediata sin esperar RTT |
| Balón (vuelo, rebotes, goles) | **Servidor** | Un solo árbitro evita desincronización |
| Posesión / conducción | **Servidor** | Decide quién "tiene" la pelota |
| Robos y faltas (cruzar pie / barrida) | **Servidor** | Anti-trampa: la colisión se valida centralmente |
| Marcador, spawns, reinicios | **Servidor** | Estado de partida |

### Flujo de datos

```
Cliente ──(state 20 Hz: pos, yaw, anim, sprint)──▶ Servidor
Cliente ──(eventos: kick / challenge)────────────▶ Servidor
Servidor ──(snap 20 Hz: balón + jugadores)───────▶ Todos
Servidor ──(eventos: goal / foul / steal / …)────▶ Todos
```

- **Tick del servidor: 30 Hz** (física del balón, resolución de desafíos).
- **Snapshots: 20 Hz**, coordenadas redondeadas a 2 decimales (menos bytes).
- **Interpolación remota**: el cliente renderiza 120 ms en el pasado entre
  dos snapshots (`NetworkClient.getInterpolationPair`) — movimiento suave
  aunque lleguen paquetes irregulares.
- **Predicción local**: el jugador propio y, cuando él posee el balón,
  también el balón, se simulan localmente para latencia cero percibida.
- Solo transporte **WebSocket** (sin long-polling) para minimizar overhead.

## Decisiones de gameplay

### Personaje "Steve" por extremidades

`SteveCharacter` construye cabeza, torso, 2 brazos y 2 piernas como mallas
independientes con pivotes en las articulaciones. **No hay un bloque
envolvente único**: el servidor replica la silueta con una cápsula por
extremidad (`server/game/physics.js → LIMB_CAPSULES`), de modo que el balón
solo rebota donde visualmente hay cuerpo — nunca en "aire".

### Cámara 360 desacoplada + strafe

La cámara orbita libre con el mouse (pointer lock). Con el personaje quieto,
la cámara **no** lo rota. Al moverse, el cuerpo encara hacia adelante
(yaw de cámara) y el movimiento lateral es un **strafe** — ir al costado no
gira el cuerpo, lo que da un control de balón más cómodo.

### Remate cargado

Mantener clic izquierdo llena la barra de poder (~0.9 s) y proyecta una
línea de puntería sobre el césped siguiendo el yaw de la cámara en tiempo
real. Al soltar, se patea con potencia `0.3..1.0`. **Sin cooldown**; solo
persiste una protección de re-captura de 450 ms para no volver a imantar
el propio pase.

### Conducción del balón

Cuando un jugador posee el balón, este persigue un punto frente a sus pies
con un seguimiento exponencial (`DRIBBLE.FOLLOW_RATE`). La distancia del
punto depende del estado:

| Estado | Distancia |
|---|---|
| Parado | 0.50 m |
| Trote  | 0.72 m |
| Sprint | 1.15 m |

Esto simula el toque real: a más velocidad, la pelota queda más lejos del pie.

### Stamina

Sprint (Shift) drena `28/s`; al soltar, regenera `20/s` → recarga completa
en ~5 s. Bajo el 10 % no se puede sprintar (evita spam de micro-sprints).

### Cruzar pie (clic ruedita) y barrida (clic derecho)

Ambos comparten la misma regla, resuelta **en el servidor** durante la
ventana activa de la acción:

1. Se proyecta el punto del pie extendido: `pos + forward * reach`
   (1.0 m cruzar pie, 1.45 m barrida).
2. **Si conecta primero con la pelota** (radio 0.62 m) → robo limpio
   (cruzar pie retiene; la barrida despeja hacia adelante).
3. **Si conecta con pierna/pie de un rival sin haber tocado la pelota**
   (radio 0.48 m) → **falta**: el infractor queda aturdido 3 s y la víctima
   retiene/recibe el balón.

## Optimización (anti-lag)

- **Sin texturas**: solo `MeshLambertMaterial`/`MeshBasicMaterial` de color plano.
- **Sin sombras dinámicas**: hemisferio + direccional sin shadow map.
- **Geometrías compartidas** entre los 8 personajes (cache de `BoxGeometry`).
- **Pixel ratio cap 1.5** para pantallas de alta densidad.
- **Snapshots compactos**: arrays numéricos redondeados, no objetos verbosos.
- **Sin build step**: Three.js por import map (CDN con cache) y ES modules
  nativos; el servidor sirve estáticos con `maxAge`.
- Balón low-poly (icosaedro subdiv 1) y red del arco como planos translúcidos.

## Escalabilidad futura

- `GameRoom` está aislado: soportar N salas es instanciar un `Map<roomId, GameRoom>`
  y particionar sockets con rooms de Socket.IO.
- Las constantes compartidas permiten mover más simulación al servidor
  (p. ej. movimiento server-authoritative) sin duplicar números mágicos.
