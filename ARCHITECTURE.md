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
├── client/assets/
│   ├── steve.gltf           # Modelo del personaje (Blockbench, con skinning)
│   └── skins/               # Texturas de skin: <nombre>.png = nombre de la skin en juego
│                            #   (listadas por GET /api/skins, elegibles in-game)
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
        │   ├── SteveCharacter.js   # Personaje (glTF de Blockbench) + animación procedural
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

### Personaje "Steve" (modelo glTF de Blockbench, con skinning)

`SteveCharacter` carga `client/assets/steve.gltf` (exportado de Blockbench
en pose neutral) con `GLTFLoader`. El export trae **skinning**: los meshes
son `SkinnedMesh` y cada parte (Head, Body, Right/Left Arm, Right/Left Leg)
es un **hueso** con el pivote en su articulación — **no es un bloque
envolvente único**: el servidor replica esa silueta con una cápsula por
extremidad (`server/game/physics.js → LIMB_CAPSULES`), de modo que el balón
solo interactúa donde visualmente hay cuerpo.

La carga es asíncrona: el modelo se descarga una sola vez (template a nivel
de módulo) y cada instancia se clona con **`SkeletonUtils.clone`** — un
`Object3D.clone` normal no rebindea el esqueleto y el modelo renderiza
descolocado. El material se crea una única vez **por equipo**, tintado
hacia `TEAM_COLORS`.

**Skins por archivo, elegibles in-game**: la textura no se toma del glTF
sino de `client/assets/skins/<nombre>.png` — el nombre del archivo es el
nombre de la skin en juego; para agregar skins basta soltar más PNGs en
esa carpeta, sin tocar código. El servidor las expone en `GET /api/skins`
(leyendo el directorio en cada join, valida que el nombre pedido exista
antes de aceptarlo) y la pantalla de ingreso arma un `<select>` con esa
lista; la elección viaja en el `join` y el servidor la reenvía a todos
(`publicPlayer().skin`), así que cada jugador ve la skin real de los
demás. Los materiales se cachean **por skin** (2 por skin, uno por
equipo), no por jugador, para que varias skins convivan sin duplicar
memoria de más.

La animación procedural (caminata, patada, cruzar pie, barrida, aturdido)
rota los huesos componiendo sobre su pose base (quaternion tal como lo
esculpió Blockbench) una rotación extra en el eje X local (`poseLimb()`).

> Nota técnica: `GLTFLoader` decodifica texturas con `createImageBitmap`,
> que en algunos entornos falla para PNGs embebidos en base64. Por eso la
> textura se carga aparte con `THREE.TextureLoader` (basado en `<img>`, más
> compatible) y se reasigna al material una vez lista.

### Cámara 360 desacoplada + strafe

La cámara orbita libre con el mouse (pointer lock). Con el personaje quieto,
la cámara **no** lo rota. Al moverse, el cuerpo encara hacia adelante
(yaw de cámara) y el movimiento lateral es un **strafe** — ir al costado no
gira el cuerpo, lo que da un control de balón más cómodo.

### Remate cargado

Mantener clic izquierdo llena la barra de poder (~0.9 s) y proyecta una
línea de puntería sobre el césped siguiendo el yaw de la cámara en tiempo
real. Al soltar, se patea con potencia `KICK_MIN_POWER..1`, aplicada con
una curva no lineal (`power^KICK_CURVE`) para que un toque suelto apenas
empuje el balón ~1 m y solo cerca de la barra llena el remate sea muy
fuerte. **Sin cooldown**; solo persiste una protección de re-captura de
450 ms para no volver a imantar el propio pase.

### El balón libre "pasa entre las piernas"

Cuando nadie lo posee, el balón **no** colisiona con el cuerpo de los
jugadores ni se captura automáticamente por cercanía — los atraviesa. La
única forma de recibirlo/controlarlo a propósito es **cruzar pie** (clic
ruedita) o la **barrida**, apuntando el pie extendido dentro de
`ACTIONS.STEAL_RADIUS`; eso es lo que ejecuta `resolveChallenge` en
`GameRoom.js`. Patear sigue funcionando por contacto directo dentro de
`KICK_RANGE`, sin necesidad de haberlo controlado antes.

### Mano (falta en cualquier animación)

Los brazos (`ARM_CAPSULES`, entre hombro y mano) se revisan en **cada
tick**, de forma independiente a la animación en curso o a quién posee el
balón (`GameRoom.checkHandball`) — aplica igual en salto, barrida o
dribbling. Cualquier contacto del balón con un brazo aturde al infractor
3 s y entrega el balón al rival más cercano.

### Balón conducido: gol y límites de cancha

Antes, mientras un jugador conducía el balón, este se movía "por fuera"
de la física estándar (`stepBall`) y nunca se comprobaban gol ni bandas.
`GameRoom.dribble()` ahora también llama a `checkGoalCrossing` y
`clampToPitch` (`physics.js`) en cada tick, así que entrar al arco con el
balón en los pies anota igual que un remate, y no se puede arrastrar el
balón a través de una banda o el fondo fuera del arco.

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

Ambos se resuelven **en el servidor** durante la ventana activa de la
acción, con prioridad pelota → rival:

- **Cruzar pie** (SIN cooldown, spameable o cronometrado): si la pelota
  está dentro del **cilindro de control** alrededor del jugador —círculo
  de `CONTROL_AREA_RADIUS`, de pies a cabeza (`CONTROL_AREA_HEIGHT`),
  cualquier ángulo— → la controla/roba. Cubre también los balones que
  llegan "volando" bajo, no solo los que ya tocaron el piso. El cliente
  dibuja el círculo bajo los pies del jugador local. La falta se evalúa
  con el pie extendido hacia adelante (`EXTEND_REACH` + `FOUL_RADIUS`).
- **Barrida** (con cooldown): **no controla el balón**. Si el pie del
  lunge conecta con una pelota controlada por el rival (`STEAL_RADIUS`)
  → solo lo **despoja** (balón suelto con un empujón corto). Si contacta
  al rival — pie o **cuerpo** deslizándose (`SLIDE_BODY_FOUL_RADIUS`) —
  es **falta**.
- Toda falta aturde al infractor 3 s y la víctima retiene/recibe el balón.

### Física de la barrida contra el balón libre

Mientras dura la barrida, el cuerpo tendido es **sólido para el balón
libre** (no solo el pie): una cápsula horizontal de la cadera al pie
extendido (`collideBallWithSlidingBody`) lo hace rebotar venga de frente,
de costado o por encima. La respuesta depende de la **zona de contacto**
y de las velocidades reales de la pelota y del jugador (ver "Velocidad
real del jugador" más abajo):

| Zona | Resultado |
|---|---|
| **Punta** (pie extendido) | Despeje frontal: sale disparada hacia adelante combinando la velocidad del balón y el envión de la carrera — ideal para empujar un pase al arco o cortar en defensa. |
| **Piernas** (tramo medio) | Rebote de fuerza media. |
| **Torso** (cerca de la cadera) | Absorción: mata casi toda la energía del balón. |

### Velocidad real del jugador (interna, no visible)

El servidor estima la velocidad real de cada jugador por diferencia de
posición entre estados sucesivos (`onPlayerState`, suavizada y con
rechazo de saltos tipo teleport). Nunca se muestra en el HUD; la usa la
física de la barrida para calcular la fuerza de salida del balón.

En el cliente, el movimiento propio ya no salta directo a la velocidad
objetivo: una velocidad interna (`local.curSpeed`, tampoco visible)
persigue el objetivo con aceleración/desaceleración (`ACCEL_JOG`,
`ACCEL_SPRINT`, `DECEL`) — el trote reacciona rápido, el sprint tarda más
en estirarse, y soltar el movimiento frena con una breve inercia.

### Remate: origen y potencia por tramos

El balón sale **siempre desde adelante del pateador, en su último punto**:
el cliente envía su posición junto al kick (validada contra teleports) y
el servidor recoloca el balón en `pos + forward * DIST_JOG` antes de
aplicar el impulso — sin esto, al patear en sprint el balón salía ~2 pasos
atrás por el lag del snapshot. La potencia es por tramos: toque suelto
→ el balón se adelanta ~1 m; media barra → ~2 m; de media a llena escala
con `KICK_CURVE` hasta `KICK_POWER` (remate real).

### Colisiones del balón conducido y confinamiento

Mientras se conduce, el balón respeta bandas, fondos y la red del arco
(`clampToPitch`, replicado en la predicción del cliente). Los jugadores
están **confinados a la cancha** (clamps de cliente y servidor), así que
no se puede rodear el arco y meter el balón "desde afuera"; conducir el
balón cruzando la línea de gol de frente sigue siendo gol.

## Optimización (anti-lag)

- **Cancha, balón y HUD sin texturas**: solo `MeshLambertMaterial`/`MeshBasicMaterial`
  de color plano. El personaje es la única excepción: usa la textura del
  modelo `.gltf` (64×64), tintada por equipo.
- **Sin sombras dinámicas**: hemisferio + direccional sin shadow map.
- **Geometrías y materiales compartidos** entre los 8 personajes: el modelo
  se carga y clona una sola vez, con 2 materiales (uno por equipo) en total.
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
