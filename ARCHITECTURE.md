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
│                            #   (listadas por GET /api/skins, elegibles in-game
│                            #   junto con la posición FIELD/GK)
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
        │   ├── InputManager.js     # Teclado/mouse + pointer lock; también recibe input táctil
        │   └── CameraController.js # Cámara orbital 360°
        ├── entities/
        │   ├── SteveCharacter.js   # Personaje (glTF de Blockbench) + animación procedural
        │   ├── Ball.js             # Balón (render + rodadura visual)
        │   └── Pitch.js            # Cancha, líneas, arcos (solo colores)
        ├── mobile/
        │   └── MobileControls.js   # Detección de móvil + joystick/botones táctiles + modo edición
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

Ambos se resuelven **en el servidor**, con lógicas separadas
(`resolveExtends` / `resolveSlideChallenge`), y **ninguno funciona con
el balón ya en los propios pies** (`onChallenge` los rechaza de entrada
si `ball.ownerId === id`).

- **Cruzar pie** (SIN cooldown ni falta): si la pelota está dentro del
  **cilindro de control** alrededor del jugador —círculo de
  `CONTROL_AREA_RADIUS` (0.63 m, -30 % del original), de pies a cabeza
  (`CONTROL_AREA_HEIGHT`), cualquier ángulo— → la controla/roba. Cubre
  también los balones que llegan "volando" bajo, no solo los que ya
  tocaron el piso. **Si no toca la pelota, no pasa absolutamente nada**
  — no hay falta por cruzar pie; es un gesto sutil, sin consecuencias si
  falla. El cliente dibuja el círculo bajo los pies del jugador local.
  La animación es una metida de pie breve (`EXTEND_DURATION_MS`, ~220 ms)
  que se reproduce en cada clic; si llega un clic nuevo mientras la
  anterior sigue en curso, se guarda uno para reproducir apenas termine
  (`local.extendQueued`), en vez de cortarla o perderlo.
- **Barrida** (con cooldown): **no controla el balón**. Si el pie del
  lunge conecta con una pelota controlada por el rival (`STEAL_RADIUS`)
  → solo lo **despoja** (balón suelto con un empujón corto). Si contacta
  al rival — pie o **cuerpo** deslizándose (`SLIDE_BODY_FOUL_RADIUS`) —
  es **falta**, aturde al infractor 3 s y la víctima cae empujada.

#### Cruzar pie simultáneo: 50/50

`resolveExtends` se corre **una vez por tick para todos los jugadores a
la vez**, no jugador por jugador: junta a todos los que tienen un
cruzar-pie activo y están en condiciones de tocar la pelota ese mismo
tick (dentro de su propio cilindro de control). Si hay un solo elegible,
gana; si hay dos o más — dos rivales llegaron en el mismo instante y en
igualdad de condiciones —, se sortea 50/50 entre ellos
(`Math.random()`, verificado ~50/50 en 400 simulaciones). Antes de este
cambio se resolvía jugador por jugador según el orden del `Map`, así que
ante una disputa simultánea siempre ganaba el mismo (quien se procesara
primero), nunca un verdadero empate.

#### Barrida: prioridad pelota vs. rival, y oclusión de cuerpo

`resolveSlideChallenge` compara la distancia² del intento a la pelota
contra la distancia² al rival más cercano — **gana lo que el pie/cuerpo
alcanza primero**, nunca "la pelota por default". Antes se chequeaba la
pelota sin condición alguna antes que al rival, así que una barrida por
detrás —donde el cuerpo del rival bloquea el camino hacia el balón— a
veces resolvía como robo de todos modos, con resultados inconsistentes
entre intentos casi idénticos.

Además, sobre ese resultado por distancia se aplica un chequeo de
**oclusión**: si el rival alcanzado queda sobre la línea recta entre el
jugador y la pelota (proyección + distancia perpendicular < ~0.7 m,
radios de cuerpo y pelota), la falta gana **siempre**, sin importar qué
distancia haya dado más corta. Hace falta porque con el rival parado y
la pelota a la distancia de reposo de sus pies (`DIST_IDLE`), el punto
de alcance del pie puede caer justo a mitad de camino entre ambos y
empatar las dos distancias — sin la oclusión, ese empate podía resolver
como robo en vez de falta.

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

**Stamina**: la duración del sprint (tiempo hasta vaciarse) subió un
+50 % — `STAMINA_MAX` escaló de 115 a 172.5 sin tocar `STAMINA_DRAIN_PER_S`
(26). Para que el **tiempo de recarga completa** no cambiara (sigue en
~5 s), `STAMINA_REGEN_PER_S` escaló en la misma proporción (23 → 34.5):
`MAX/REGEN` da 5 s antes y después.

### Remate: origen y potencia por tramos

El balón sale **siempre desde adelante del pateador, en su último punto**:
el cliente envía su posición junto al kick (validada contra teleports) y
el servidor recoloca el balón en `pos + forward * DIST_JOG` antes de
aplicar el impulso — sin esto, al patear en sprint el balón salía ~2 pasos
atrás por el lag del snapshot.

La potencia está **muy adelantada**: con la barra recién empezada
(`KICK_PIVOT_CHARGE`, ~20 %) el remate ya "se siente" fuerte de verdad
(`KICK_PIVOT_SPEED`) — antes hacía falta cargar ~75-80 % para sentir algo,
ese mismo punch ahora se siente a los ~20 %. De ahí a la barra llena sigue
creciendo hasta el máximo (`KICK_POWER`). Es una curva de dos tramos:
`[0, PIVOT]` con ease-in cuadrático (el toque mínimo se mantiene suave,
~1 m) y `[PIVOT, 1]` con crecimiento sostenido (exponente `KICK_CURVE`
bajo) hasta el tope. Los tres segmentos (`KICK_MIN_SPEED`,
`KICK_PIVOT_SPEED`, `KICK_POWER`) están un +10 % por encima de sus
valores previos.

### Colisiones del balón conducido y confinamiento

Mientras se conduce, el balón respeta bandas, fondos y la red del arco
(`clampToPitch`, replicado en la predicción del cliente). Los jugadores
están **confinados a la cancha** (clamps de cliente y servidor), así que
no se puede rodear el arco y meter el balón "desde afuera"; conducir el
balón cruzando la línea de gol de frente sigue siendo gol.

### Colisión entre jugadores

Nadie se atraviesa: cada tick del servidor (`resolvePlayerCollisions`)
separa a todos los pares de jugadores superpuestos con un push-apart
círculo-círculo preciso sobre `PLAYER.RADIUS` (`resolvePlayerCollision`
en `physics.js`), y el cliente predice lo mismo contra sus vecinos para
que se sienta inmediato. Se excluye a quien está en el aire (saltando) o
**barriéndose** — ese contacto lo resuelve el sistema de faltas, no un
empujón genérico, para no interferir con el lunge.

### Falta física: el infractor cae y se levanta, la víctima sale despedida

Antes, al cometer falta en barrida, el personaje saltaba de golpe a la
pose de aturdido de pie — como si abrazara al rival — mientras el lunge
seguía trasladándolo. Ahora:

- **Infractor** (solo en faltas de barrida): el lunge se corta al
  instante (`local.slideUntil = now`) y queda **tendido** (misma pose que
  la barrida) durante `FOUL_GROUND_MS`, recién ahí pasa a la pose de
  aturdido de pie por el resto de `FOUL_STUN_MS` — como el final de una
  barrida normal, no un salto brusco.
- **Víctima**: recibe un empujón (`ANIM.KNOCKED`, sin control de WASD)
  en la dirección del golpe durante `KNOCKBACK_MS`, a velocidad
  `KNOCKBACK_SPEED` decayendo. La dirección es la del movimiento del
  infractor si venía corriendo, o si estaba quieto, la línea
  infractor → víctima; el evento `foul` viaja con `dir`/`speed` para que
  el cliente de la víctima lo aplique.

### Colisión aérea: cualquier salto conecta con el balón, sin clic

Mientras un jugador está en el aire (`pos.y > AIRBORNE_COLLISION_MIN_Y`)
—salto normal o el clavado de arquero— el balón libre **siempre**
rebota contra su cuerpo, automáticamente, sin necesidad de ningún clic
(`collideBallWithAirborneBody`, llamada para todos los jugadores en el
tick, igual que la colisión de la barrida). Mismo criterio de zonas que
la barrida pero con el cuerpo vertical:

| Zona | Resultado |
|---|---|
| **Cabeza** | Cabezazo/despeje dirigido hacia adelante, combinando la velocidad del balón con el envión del salto — jugada de **ataque** (cabecear un centro). |
| **Torso/brazos** | Bloqueo — absorbe casi toda la energía — jugada **defensiva** (tapar un remate). |
| **Piernas** | Rebote de fuerza media. |

Solo aplica al balón **libre** (mismo criterio que la barrida: el balón
en los pies de alguien no se ve afectado por saltos ajenos).

### Sistema de arquero (GK)

La pantalla de ingreso tiene un selector de posición junto al de skin
(`FIELD` / `GK`), que viaja en el `join` y el servidor reenvía a todos
(`publicPlayer().position`) — otros jugadores ven "(GK)" junto al nombre
de quien lo eligió.

Solo un jugador en posición `GK` puede hacer el **clavado lateral**:
mientras está en el aire (ya saltó) y se mueve claramente al costado
(input de strafe > 0.3), presionar **clic izquierdo** (no cargarlo como
remate) dispara un salto lateral a **media altura** (`DIVE_HEIGHT_MULT =
0.5`, la velocidad vertical se relanza a `JUMP_SPEED·√0.5` para que el
pico sea la mitad) con deriva constante hacia el costado
(`DIVE_SIDE_SPEED`) hasta aterrizar — sin control de WASD durante el
clavado. El disparo usa el flanco de bajada del clic (`InputManager`
expone `queued.kickPress`, distinto de `kickHeld`) para no confundirse
con la carga normal del remate — mientras dura el clavado, `kickHeld`
queda completamente ignorado (no se acumula carga ni se dispara un
remate fantasma al soltar el mouse en el aire). No hace falta nada
especial para que colisione con el balón: al estar en el aire, ya cae
bajo la colisión aérea automática de arriba (misma lógica de zonas,
misma cápsula) — y si esa colisión ocurre dentro de SU área de meta, en
vez de rebotar la ataja con las manos (ver "Área de meta" más abajo).

Al aterrizar, el arquero no vuelve directo a la pose de pie: queda
**tendido de costado** (`ANIM.DIVE_GROUND`, `PLAYER.DIVE_GROUND_MS` ≈
650 ms, sin control de WASD) hacia el lado real por el que voló, y recién
después se levanta solo (vuelve a control normal) — salvo que haya
atajado el balón en el aire, en cuyo caso aterriza directo en la pose de
atajada (`ANIM.CATCH`) en vez de desplomarse. Antes el aterrizaje volvía
a la pose normal en el mismo frame, lo que se veía como un salto brusco
del vuelo a estar parado.

#### Dirección real de la animación (no un signo fijo)

El impulso del clavado (`diveDirX/Z`) siempre fue correcto para ambos
lados, pero la pose (`ANIM.DIVE` en `SteveCharacter`) usaba un
`rotation.z` constante — se veía "hacia la izquierda" sin importar hacia
qué lado se tirara el arquero. `SteveCharacter.update()` ahora deriva el
lado real cada frame a partir del **movimiento observado** (delta de
posición del propio `group` sobre el vector "derecha" del yaw actual,
`this._diveSide`), no de un dato explícito — así funciona igual para el
jugador local que para remotos (interpolados desde la red), sin mandar
nada extra por el socket. La pose en sí se rehizo: cuerpo completamente
recto (`rotation.x = 0`) y ambos brazos rectos hacia el cielo (mismo
ángulo que usa `ANIM.JUMP` para "brazos arriba"), con el único lean hacia
el lado real en `rotation.z = -0.6 * diveSide`.

#### Colisión automática de cuerpo (sin cruzar pie)

A diferencia de un jugador de campo (que deja pasar el balón libre "entre
las piernas" salvo que presione cruzar pie o se barra), el **arquero de
pie también es sólido** contra el balón libre en todo momento
(`collideBallWithPlayer` en el tick, cuando no está en el aire ni
barriéndose/volando bajo) — bloquea/rebota automáticamente, como un
arquero real parado en el camino de un remate. Esto NO controla el
balón — solo lo desvía; atajarlo de verdad (ver abajo) requiere estar en
pleno clavado o vuelo bajo.

#### Área de meta y atajada con las manos (automática, sin botón)

Cada arco tiene un **área de meta** rectangular (`FIELD.PENALTY_WIDTH` ×
`FIELD.PENALTY_DEPTH`, dibujada en `Pitch.js`) frente a él. Dentro de SU
propia área (`GameRoom.isInOwnPenaltyArea`), si el balón LIBRE **toca**
el cuerpo del arquero mientras está en pleno clavado (`p.anim ===
ANIM.DIVE`) o vuelo bajo (`p.challenge.type === 'lowdive'`), lo ataja con
las manos automáticamente — no hace falta presionar nada, el contacto
mismo lo dispara (`GameRoom.tick`, usa el valor de retorno `hit` de
`collideBallWithAirborneBody`/`collideBallWithLowDiveBody` para decidir
entre rebotar o atajar). `catchBall()` pasa `ball.ownerId` al arquero con
un flag extra `ball.caught = true`; con ese flag, `dribble()` deja de
perseguir el punto habitual a los pies y en cambio fija el balón cerca
del pecho (`owner.pos + forward·0.35`, altura `owner.pos.y + 1.15`) — y
no lo suelta aunque el arquero siga "en el aire" terminando de aterrizar
(única excepción a la regla de soltar el balón si `owner.pos.y > 0.6`).
El cliente refleja lo mismo en su predicción (`GameClient.local.holding`,
seteado al recibir el evento `caught`) y muestra la pose `ANIM.CATCH`
("zombie", brazos rectos al frente) mientras dure la posesión — se
libera recién al patear. **Fuera** del área de meta, o sin estar en pleno
clavado/vuelo bajo, cruzar pie sigue funcionando exactamente igual que
para cualquier jugador: control con el pie.

#### Vuelo bajo (solo arquero)

Mismo gesto que la barrida, pero **lateral** en vez de hacia adelante:
si el arquero mantiene A/D (sin W) y presiona barrida (clic derecho), en
vez de un lunge hacia adelante hace un vuelo bajo hacia el costado
(`onChallenge` tipo `'lowdive'`, exclusivo de `position === 'GK'`). **SIN
cooldown** (a diferencia de la barrida recta, que sí lo tiene — es la
única acción del juego con cooldown propio) — solo no puede solaparse
con otra acción en curso (`p.challenge` ocupado). No controla el balón ni
cobra falta contra rivales — es puramente una colisión de cuerpo
automática contra el balón libre (`collideBallWithLowDiveBody` en
`physics.js`), igual que `collideBallWithSlidingBody` pero con la cápsula
orientada hacia el costado (vector "derecha" del yaw × `side`) en vez de
hacia adelante, porque el desplazamiento real es lateral; si el balón la
toca dentro del área de meta, se ataja igual que en el clavado alto (ver
arriba). La pose (`ANIM.LOW_DIVE`) usa un ROLL sobre el eje Z para caer
de costado y quedar horizontal — antes usaba el eje X (picado hacia
adelante), por lo que se veía como si el arquero se tirara de cabeza al
frente en vez de estirarse hacia el costado.

#### Disparo por clic izquierdo, sin interferir con la carga del remate

El clavado se dispara con el **flanco de bajada** del clic izquierdo
(`InputManager.queued.kickPress`, distinto de `kickHeld` que se mantiene
mientras el botón sigue apretado) — así un mismo clic no dispara además
la carga de un remate. Mientras dura el clavado (o el vuelo bajo, o la
recuperación tendido-en-el-suelo tras aterrizar), el bloque de acciones
completo queda bloqueado (igual que aturdido/barrida/etc.), así que
`kickHeld` se ignora por completo — no acumula carga ni dispara un
remate fantasma si el jugador suelta el mouse recién al aterrizar.

### Barrida: distancia según la velocidad real, no un valor fijo

Antes, cualquier barrida recorría la misma distancia (`SLIDE_SPEED`
constante) sin importar si el jugador venía parado, trotando o
sprintando. Ahora el lunge arranca con la velocidad real que traía
(`local.curSpeed`, la misma que usa el movimiento normal) y frena solo
por deceleración natural (`SLIDE_DECEL`, m/s²) durante la ventana de la
barrida — parado, apenas se desliza unos centímetros; sprintando, recorre
varios metros. La física de barrida contra el balón (`collideBallWithSlidingBody`)
ya usaba la velocidad real estimada del jugador (`GameRoom.onPlayerState`),
así que la potencia de la barrida contra el balón queda consistente sin
tocar nada del lado servidor.

### Cruzar pie sin animación

`ANIM.EXTEND` se eliminó de la animación procedural (`SteveCharacter`) y
del cliente (`GameClient` ya no setea `local.anim = ANIM.EXTEND`): la
acción sigue funcionando igual (server-authoritative, sin cooldown), pero
visualmente no hay pose — es un gesto instantáneo, sin metida de pie.

### Altura del remate: desacoplada de la potencia

Primera versión: la altura dependía de `charge` igual que la potencia
(`liftT = (charge-0.1)/0.9`), así que con la barra casi vacía la
elevación quedaba en ~0 sin importar hacia dónde mirara la cámara —
imposible levantar un centro corto y controlable, solo pelotazos largos
con algo de altura si además se cargaba fuerte.

Ahora la altura (`ball.vel.y`) es una suma de tres términos independientes
(`GameRoom.onKick`, mismo cálculo replicado en el cliente para la
previsualización — ver abajo):

```
vel.y = KICK_LIFT_BASE + pitchNorm · KICK_LIFT_PITCH_MAX + charge · KICK_LIFT_CHARGE_BONUS
```

- `KICK_LIFT_BASE` (0.4): lift residual incluso mirando al piso — nunca
  sale 100% pegado al suelo.
- `pitchNorm · KICK_LIFT_PITCH_MAX` (hasta 9.5): el término dominante,
  depende SOLO de hacia dónde apunta la cámara verticalmente
  (`pitchNorm` normaliza `CAMERA.PITCH_MIN/MAX` a 0=piso..1=cielo) — con
  esto, incluso un toque al 5% de carga mirando bien arriba levanta el
  balón por encima de la altura de la cabeza (~1.8 m), habilitando centros
  cortos y controlables.
- `charge · KICK_LIFT_CHARGE_BONUS` (hasta 4): un extra menor según la
  potencia, para que los remates a barra llena también puedan salir con
  comba (no solo los suaves).

La potencia (`speed`, distancia horizontal) sigue dependiendo solo de
`charge`, sin tocar — quedan dos ejes de control totalmente
independientes: cuánto se carga la barra = qué tan lejos/fuerte sale;
hacia dónde mira la cámara = qué tan alto sale.

### Recorrido previsto del remate (previsualización en vivo)

La barra de poder ya no solo muestra una línea recta sobre el césped: la
`aimLine` ahora es una `THREE.Line` con una `BufferGeometry` dinámica de
hasta `AIM_TRAJECTORY_POINTS` puntos, recalculada cada frame mientras se
carga (`GameClient.updateAimTrajectory`, llamada desde `updateLocalPlayer`
en vez de solo ajustar `scale.z`). Muestrea la parábola real integrando
gravedad (mismo `BALL.GRAVITY`) con la MISMA física que aplicará el
servidor — misma curva de potencia por tramos y misma fórmula de altura
por pitch que `GameRoom.onKick` — y corta el muestreo (`setDrawRange`) en
cuanto la curva toca el piso, así el largo de la línea también refleja el
alcance real. Al depender de `kickCharge` y `cameraCtrl.pitch` en cada
llamada, la curva se ajusta en vivo a medida que se carga la barra o se
mueve la cámara.

### Controles táctiles (móvil)

`isMobileDevice()` (en `MobileControls.js`) detecta móvil por
`matchMedia('(pointer: coarse)')` **y** soporte touch (`ontouchstart`/
`maxTouchPoints`) a la vez — así una laptop con pantalla táctil (puntero
preciso) no cae en el modo móvil por error. `main.js` la chequea una sola
vez al bootear: si es móvil, agrega `body.is-mobile` (oculta la ayuda de
teclado en la pantalla de ingreso) e instancia `MobileControls`, y evita
pedir pointer lock (`input.lock()`), que no aplica a touch.

**`InputManager` es la única fuente de verdad de input**: `MobileControls`
no toca `GameClient` en absoluto, solo llama a métodos nuevos del mismo
`InputManager` que ya usan teclado/mouse (`setTouchAxis`, `trigger`,
`setKickHeld`, `setTouchSprint`, `addLookDelta`) — por eso `GameClient.js`
no necesitó ningún cambio para soportar touch. `moveAxis` prioriza
`touchAxis` sobre WASD cuando el joystick está activo; `sprint` es
`Shift || touchSprint`.

`MobileControls` arma un joystick (drag dentro de un radio máximo → eje
`{x, z}` normalizado, `z` invertido porque arrastrar hacia arriba en
pantalla es "adelante") y cinco botones de acción (patear = mantener/soltar
igual que el clic izquierdo; cruzar pie/barrida/salto = one-shot; sprint =
toggle). Arrastrar sobre el resto del canvas (fuera de joystick/botones)
alimenta `addLookDelta` con el delta de dedo en píxeles — mismo canal que
`movementX/Y` del mouse, así que `CameraController` no distingue el origen.

**Modo edición**: el botón ⚙ activa `editMode`, que (a) muestra un panel con
sliders de tamaño/opacidad (escritos como CSS custom properties
`--touch-scale`/`--touch-opacity` en el contenedor raíz) y botones
Restablecer/Listo, y (b) hace que cada control (joystick y botones) se
vuelva arrastrable — mismo listener de `touchmove` que en juego, pero
gateado por `editMode` en vez de disparar la acción. Layout (posiciones en
% de viewport) y preferencias (escala/opacidad) se guardan por separado en
`localStorage` (`sokkaio.touchControls.layout` / `.prefs`) y se recargan al
instanciar. Al entrar en modo edición se limpia cualquier input táctil
activo (`setTouchAxis(null)`, `setKickHeld(false)`) para que no quede un
movimiento o remate "pegado" mientras el jugador reacomoda los controles.

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
