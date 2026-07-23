# ADR-0003: Un solo Orchestrator (COO Agent) in-process, no coordinación distribuida

- Estado: Aceptado
- Fecha: 2026-07-23
- Fase: F25

## Contexto

`01_ARQUITECTURA_v1.1.md` ya reconoce explícitamente que un entorno
multi-instancia correría el `scheduler.ts` actual duplicado por
proceso, y lo acepta "al volumen actual de un solo proceso Node". F25
introduce el COO/Orchestrator Agent (agente #2 del modelo
organizacional) como coordinador operativo central. La pregunta de
diseño es si ese coordinador debe soportar múltiples instancias
compitiendo por trabajo desde el día uno, o uno solo.

## Decisión

El Orchestrator arranca como **un único proceso lógico por tenant-set**
(hoy, un único tenant real operando), reclamando tareas de la cola
Postgres (ADR-0001) vía `SKIP LOCKED`. El mecanismo de claim en sí ES
seguro para múltiples instancias compitiendo (`SKIP LOCKED` es
exactamente para eso) — la decisión NO es "hacerlo inseguro para
múltiples instancias", es **no operar múltiples instancias todavía**,
porque:

- El volumen actual (un tenant real, decenas de tareas por sweep) no
  lo justifica.
- Ejecutar 2+ instancias del Orchestrator hoy no gana nada — el cuello
  de botella real son los proveedores externos (OpenAI, Google Places),
  no la capacidad de cómputo del Orchestrator.
- El `SKIP LOCKED` deja la puerta abierta: escalar a 2+ instancias
  después es un cambio de despliegue (correr más réplicas del mismo
  proceso), no un cambio de arquitectura ni de contratos.

## Alternativas consideradas

1. **Coordinación distribuida real desde el día uno** (leader
   election, particionado de tenants entre instancias). Rechazado —
   complejidad innecesaria para el volumen actual; el propio `SKIP
   LOCKED` de ADR-0001 ya da consistencia si en el futuro se necesitan
   varias instancias, sin necesitar leader election.
2. **Seguir sin ningún Orchestrator, cada agente auto-organizándose.**
   Rechazado — el modelo organizacional del PO pide explícitamente un
   COO Agent como coordinador central (responsabilidad #2 de la
   instrucción maestra); repartir la coordinación entre 23 agentes sin
   un punto central de verdad sobre "qué se está ejecutando ahora mismo"
   viola el principio de auditabilidad (#4 de los principios de
   arquitectura).

## Consecuencias

- El Orchestrator es un solo `AgentInstance` (o proceso interno) por
  ahora — ningún cambio de infraestructura de despliegue en Render
  necesario para F25.5.
- La interfaz de claim (`SKIP LOCKED`) ya es multi-instancia-segura sin
  trabajo adicional cuando llegue el momento de escalar — no hay deuda
  técnica oculta en esta decisión, solo una decisión de NO activar algo
  que el mecanismo ya soporta.
