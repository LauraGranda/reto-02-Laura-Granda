# Supuestos

- El PRD sugiere el ciclo del agente dentro de server.ts. Se separó en src/agent/loop.ts para probarlo sin HTTP y para que server.ts solo maneje rutas. La lógica de las herramientas vive en src/tools/dominio/ para que toda la ejecución quede bajo src/tools/, respetando la separación comportamiento/conocimiento/ejecución.
