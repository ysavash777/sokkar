# ⚽ Sokkaio

Juego de fútbol **4v4 online** en tercera persona, hecho con **Three.js**,
HTML, CSS y JS puro (sin build step) + **Node.js / Socket.IO**.

Entrás con un nickname, elegís una skin y una posición, y ya estás en la
partida.

## Skins y posición

La pantalla de ingreso trae un selector con las skins disponibles. Para
agregar una, soltá un `.png` en [client/assets/skins/](client/assets/skins) —
el nombre del archivo (sin extensión) es el nombre que aparece en el
selector. No hace falta tocar código.

También elegís tu posición: **Jugador de campo** o **Arquero**. Solo el
arquero puede hacer el clavado lateral (ver Controles).

## Controles

| Entrada | Acción |
|---|---|
| `WASD` | Moverse (relativo a la cámara, con strafe lateral y aceleración/frenado con inercia) |
| `Mouse` | Cámara 360° (no rota al personaje si está quieto) |
| `Shift` | Sprint (stamina, recarga completa en ~5 s) |
| `Espacio` | Salto |
| `Clic izquierdo (mantener)` | Cargar remate: barra de poder + recorrido previsto según potencia y hacia dónde mirás con la cámara; se dispara al soltar (sin cooldown) |
| `Clic ruedita` | Cruzar pie (sin cooldown) — controla/roba el balón dentro del círculo bajo tus pies, en cualquier ángulo |
| `Clic derecho` | Barrida (única acción con cooldown) — en el piso, en línea recta o con W |
| `Clic derecho en el aire` (solo arquero) | Clavado lateral a media altura, hacia donde te estés moviendo con A/D (sin cooldown) |
| `Clic derecho + A/D (sin W)` (solo arquero) | Vuelo bajo: mismo clavado pero pegado al piso, sin cooldown |

> Cruzar pie: metida de pie sutil y breve. Si la pelota está dentro del
> **cilindro de control** que ves marcado en la base de tu personaje (de
> tus pies a tu cabeza, no solo al ras del piso), te la quedás — podés
> spamear el botón o tocarlo justo cuando llega, incluso si viene un poco
> volando. **Si no tocás la pelota, no pasa nada** — nunca es falta.
> Si dos rivales llegan a la vez y ambos podían tocarla, se define 50/50.
> Barrida: **no controla** — si tu pie conecta la pelota del rival, se la
> **quita** (queda suelta); si contactás al **rival** (pie o cuerpo), es
> **falta** (3 s aturdido). Mientras barrés, tu cuerpo entero es sólido
> para el balón libre: según le pegue en la **punta del pie** (despeje
> fuerte hacia adelante), las **piernas** (rebote medio) o el **torso**
> (absorbe casi toda la energía), la pelota reacciona distinto — es la
> jugada clave para cortar un pase o empujarla al arco en el momento
> justo. El balón libre no se pega solo: si no cruzás el pie ni saltás
> (ver abajo), te atraviesa como si pasara entre las piernas.
>
> Cualquier salto —de cualquier jugador, sin apretar nada— también hace
> que el balón libre rebote contra tu cuerpo: de **cabeza** lo despejás
> fuerte hacia adelante (ataque), con el **torso/brazos** lo bloqueás
> casi entero (defensa), con las **piernas** rebota a media fuerza.
>
> Toda falta se cobra distinguiendo bien quién chocó con qué: si el rival
> te bloquea el camino a la pelota (por ejemplo barriéndote por detrás,
> donde es físicamente imposible llegar a tocarla), siempre es falta —
> nunca roba por casualidad. El infractor en barrida queda tendido en el
> piso y se levanta como al final de una barrida normal; la víctima sale
> despedida en la dirección del golpe.
>
> Remate: la barra está adelantada — con solo ~20 % ya sentís un remate
> fuerte de verdad (antes hacía falta cargar ~80 %); de ahí sigue
> creciendo hasta el cañonazo a barra llena. Un toque bien suelto sigue
> siendo apenas un empujón de ~1 m. Correr de espaldas es más lento que
> de frente, y arrancar a moverse o frenar tiene una breve inercia
> (aceleración/desaceleración, no es instantáneo).
>
> Altura del remate: depende SOLO de hacia dónde mirás con la cámara, la
> potencia nunca la determina — mirá al cielo y sale con arco, mirá al
> piso y sale rasante, sin importar cuánta barra cargaste. Eso sí, cuanto
> más alto lo levantás, menos lejos llega (te "cuesta" velocidad
> horizontal) — un buen centro se hace con un buen timing (~media barra)
> apuntando bien arriba, no cargando al máximo. Mientras cargás, la línea
> de puntería muestra el arco real que va a hacer el balón, ajustándose
> en vivo a la potencia y hacia dónde apuntás.
>
> Los jugadores no se atraviesan entre sí — colisión de cuerpo precisa.
>
> Si el balón toca tu **brazo** (entre hombro y mano) en cualquier
> momento —salto, barrida, lo que sea— es **mano**: falta automática.
>
> Sprintar agota la stamina un 50 % más de lo que agotaba antes (el
> tiempo de recarga no cambió, sigue en ~5 s); **no recarga mientras
> sigas apretando Shift**, aunque ya no puedas sprintar. Soltalo para que
> vuelva a cargar (más rápido si estás parado del todo).
>
> Arquero (`GK`): dentro de su propia área de meta, si el balón toca su
> cuerpo mientras está en pleno clavado o vuelo bajo, lo ataja con las
> manos automáticamente (sin apretar nada) y queda parado con el balón en
> las manos hasta que patea. Fuera del área, controla con los pies como
> cualquier jugador. Ninguna de estas acciones tiene cooldown — la única
> acción del juego con cooldown es la barrida recta.

Arriba a la izquierda del HUD hay un medidor de ping en vivo. Hay sonido
de trote (distinto con/sin balón, el tono sube y baja con la velocidad) y
de remate — para que suenen hace falta soltar `run.ogg`, `ballrun.ogg` y
`shot.ogg` en [client/assets/sounds/](client/assets/sounds) (no vienen
incluidos; sin ellos el juego funciona igual, mudo).

## Móvil

En un dispositivo táctil (detección automática por `pointer: coarse` +
soporte touch) el juego reemplaza teclado/mouse por controles en pantalla:

- **Joystick** virtual (abajo a la izquierda) para moverse.
- **Botones de acción**: patear (mantener para cargar potencia, soltar para
  rematar), cruzar pie, barrida, salto y sprint (toggle).
- Arrastrar el dedo sobre el resto de la pantalla mueve la cámara (equivalente
  al mouse).
- Botón de **pantalla completa** (⛶, arriba a la derecha).
- Botón de **configurar** (⚙): entra en modo edición para arrastrar cada
  control a otra posición y ajustar tamaño/opacidad con dos sliders. Todo se
  guarda en el dispositivo (`localStorage`) y persiste entre partidas.

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
