const express = require('express')
const cors = require('cors')
const multer = require("multer");

const mysql = require('mysql2/promise');
const app = express()

const db = mysql.createPool({
    host: 'mysql-2bb46cb6-mateobaute10-8084.d.aivencloud.com',
    user: 'avnadmin',
    password: 'AVNS_jFiUEZuuCMRT7TL8vah',
    database: 'imperio-gym',
    waitForConnections: true,
    connectionLimit: 10,
    port: 22286
});

app.use(cors())
app.use(express.json())




const upload = multer({
    storage: multer.memoryStorage()
});


app.post('/register', async (req, res) => {
    const { name, pass, email } = req.body;

    try {
        if (!name || !pass || !email) {
            return res.status(400).json({ succes: false, menssage: 'Complete all fields' })
        }
        const sql = "INSERT INTO users (name, password, email) VALUES (?, ?, ?)";
        await db.execute(sql, [name, pass, email]);

        res.status(201).json({
            succes: true,
            menssage: 'Successfully registered user'
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({
            succes: false,
            menssage: 'Error registering user'
        });
    }
});

app.post('/login', async (req, res) => {
    const { name, pass } = req.body;

    try {
        const sql = 'SELECT * FROM users WHERE name = ? AND password = ?';
        const [rows] = await db.execute(sql, [name, pass]);

        if (rows.length > 0) {
            res.status(200).json({
                success: true,
                user: rows[0].name,
                admin: rows[0].admin,
                id: rows[0].id
            });
        } else {
            res.status(401).json({ success: false, menssage: 'Invalid credentials' })
        }
    } catch (error) {
        console.error(error)
        res.status(500).json({ success: false, menssage: "Server error" })
    }
})

app.get('/rutinas', async (req, res) => {
    try {
        const connection = await db.getConnection(); // Obtenemos una conexión

        // 1. AMPLIAMOS EL LÍMITE DE CARACTERES PARA ESTA SESIÓN
        await connection.execute("SET SESSION group_concat_max_len = 10000");

        const sql = `SELECT 
            r.id, 
            r.nombre_rutina, 
            r.nivel, 
            CONCAT('[', 
                GROUP_CONCAT(
                    JSON_OBJECT(
                        'ejercicio_id', e.id,
                        'nombre', e.nombre, 
                        'series', rd.series, 
                        'repeticiones', rd.repeticiones
                    )
                ),
                ']') AS ejercicios
        FROM rutinas r
        JOIN rutina_detalle rd ON r.id = rd.rutina_id
        JOIN ejercicios e ON rd.ejercicio_id = e.id
        GROUP BY r.id, r.nombre_rutina, r.nivel
        ORDER BY r.nombre_rutina;`;

        const [rows] = await connection.execute(sql);
        connection.release(); // Liberamos la conexión

        const dataFormateada = rows.map(row => ({
            ...row,
            ejercicios: typeof row.ejercicios === 'string' ? JSON.parse(row.ejercicios) : row.ejercicios
        }));

        res.status(200).json({
            success: true,
            data: dataFormateada
        });
    } catch (error) {
        console.error("Error en el servidor:", error);
        res.status(500).json({ success: false, message: "Error interno" });
    }
});

app.get('/ejercicios', async (req, res) => {
    try {
        const sql = `SELECT * FROM ejercicios`
        const [rows] = await db.execute(sql)
        res.status(200).json({
            success: true,
            data: rows
        });

    } catch (error) {
        console.error('Error en el servidor', error)
        res.status(500).json({
            success: false,
            menssage: 'Error interno del servidor'
        })
    }
})

app.post('/nuevaRutina', async (req, res) => {
    // asegurarse de que los campos numéricos llegan como números válidos
    let { nombreRutina, nivel, creador, ejercicios } = req.body;
    creador = parseInt(creador, 10) || null;

    if (!Array.isArray(ejercicios)) ejercicios = [];
    ejercicios = ejercicios.map(ej => ({
        ejercicio_id: parseInt(ej.ejercicio_id, 10) || null,
        series: parseInt(ej.series, 10) || 0,
        repeticiones: parseInt(ej.repeticiones, 10) || 0
    }));

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // 1. Insertar la rutina general
        const [resRutina] = await connection.execute(
            'INSERT INTO rutinas (nombre_rutina, nivel, creador) VALUES (?, ?, ?)',
            [nombreRutina, nivel, creador]
        );
        const rutinaId = resRutina.insertId;

        // 2. Insertar cada ejercicio del array
        const sqlDetalle = 'INSERT INTO rutina_detalle (rutina_id, ejercicio_id, series, repeticiones, orden) VALUES (?, ?, ?, ?, ?)';

        for (let i = 0; i < ejercicios.length; i++) {
            const { ejercicio_id, series, repeticiones } = ejercicios[i];
            await connection.execute(sqlDetalle, [rutinaId, ejercicio_id, series, repeticiones, i + 1]);
        }

        await connection.commit();
        res.status(200).json({ success: true, message: 'Rutina creada!' });

    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.status(500).json({ success: false, message: 'Error al guardar' });
    } finally {
        connection.release();
    }
});

app.patch('/editarRutina/:id', async (req, res) => {
    // parsear id de parámetro y datos numéricos del cuerpo
    let rutinaId = parseInt(req.params.id, 10);
    if (isNaN(rutinaId)) {
        return res.status(400).json({ success: false, message: 'ID de rutina inválido' });
    }

    let { nombreRutina, nivel, creador, ejercicios } = req.body;
    creador = parseInt(creador, 10);
    if (!creador) {
        return res.status(400).json({ success: false, message: "creador inválido" });
    }
    if (!Array.isArray(ejercicios)) ejercicios = [];
    ejercicios = ejercicios.map(ej => ({
        ejercicio_id: parseInt(ej.ejercicio_id, 10),
        series: parseInt(ej.series, 10),
        repeticiones: parseInt(ej.repeticiones, 10)
    }));

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const sqlUpdateRutina = 'UPDATE rutinas SET nombre_rutina = ?, nivel = ?, creador = ? WHERE id = ?';
        // Usamos las variables corregidas (rutinaId en lugar de id)
        await connection.execute(sqlUpdateRutina, [nombreRutina, nivel, creador, rutinaId]);

        await connection.execute('DELETE FROM rutina_detalle WHERE rutina_id = ?', [rutinaId]);

        const sqlInsertEjercicios = 'INSERT INTO rutina_detalle (rutina_id, ejercicio_id, series, repeticiones, orden) VALUES (?, ?, ?, ?, ?)';
        for (const ej of ejercicios) {
            await connection.execute(sqlInsertEjercicios, [rutinaId, ej.ejercicio_id, ej.series, ej.repeticiones, null]);
        }

        await connection.commit(); // IMPORTANTE
        res.status(200).json({ success: true, message: 'Editado con éxito' });
    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.status(500).json({ success: false, message: 'Error interno' });
    } finally {
        connection.release();
    }
});

app.delete('/rutinaEliminar/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Ejecutas las 3 sentencias SQL (Detalle, Usuario_Rutina y Rutina)
        await db.query("DELETE FROM rutina_detalle WHERE rutina_id = ?", [id]);
        await db.query("DELETE FROM usuario_rutina WHERE rutina_id = ?", [id]);
        await db.query("DELETE FROM rutinas WHERE id = ?", [id]);

        res.status(200).send("Eliminado");
    } catch (error) {
        res.status(500).send(error);
    }
});

app.get('/productosGet', async (req, res) => {
    try {
        const sql = "SELECT * FROM productos";

        const [rows] = await db.execute(sql);
        res.status(200).json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: 'Error al obtener productos'
        });
    }
});

app.post("/productos", upload.single("imagen"), (req, res) => {
    const { nombre, precio, descripcion, size, color } = req.body;
    const imagen = req.file.buffer;
    // console.log(descripcion)

    const sql = `
    INSERT INTO productos (name, price, description, img, size, color)
    VALUES (?, ?, ?, ?, ?, ?)
  `;

    db.query(sql, [nombre, precio, descripcion, imagen, size, color], (err) => {
        if (err) {
            console.error(err);
            return res.status(500).send("Error al guardar");
        }

        res.send("Producto creado correctamente");
    });
});


app.get("/productos/:id/imagen", async (req, res) => {
    try {
        const { id } = req.params;

        const sql = "SELECT img FROM productos WHERE id = ?";

        const [result] = await db.query(sql, [id]);

        if (result.length === 0) {
            return res.status(404).send("No encontrado");
        }

        const imagenRaw = result[0].img;

        if (!imagenRaw) {
            return res.status(404).send("Sin imagen");
        }

        const imagen = Buffer.from(imagenRaw.data || imagenRaw);

        res.setHeader("Content-Type", "image/png", "image/jpeg", "image/jpg");
        res.end(imagen);

    } catch (err) {
        console.error(err);
        res.status(500).send("Error");
    }
});

app.delete('/productos/eliminar', async (req, res) => {
    const { id } = req.body;
    // console.log(id);

    try {
        const sql = "DELETE FROM productos WHERE id = ?";
        const [resultts] = await db.execute(sql, [id]);
        res.status(200).send("Producto eliminado correctamente");
    } catch (error) {
        console.error(error);
        res.status(500).send("Error al eliminar el producto");
    }
});

app.post('/guardarCompra', async (req, res) => {
    let { idProducto, idUsuario, fecha } = req.body;

    try {
        const sql = "INSERT INTO `compras`( `idProducto`, `idUsuario`, fechaCompra) VALUES ( ?, ?, ?)";

        await db.execute(sql, [idProducto, idUsuario, fecha]);

        res.status(201).json({
            success: true,
            message: 'Producto Guardado Correctamente'
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: 'Ha ocurrido un problema en el servidor'
        });

    };
});

app.get('/compras', async (req, res) => {
    try{
        const sql = 'select * from compras';
        const [rows] = await db.execute(sql);

        res.status(201).json({
            success: true,
            compras: rows
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: 'Ha ocurrido un problema en el servidor'
        });
    }
});

app.get('/comprasUsuario', async (req, res) => {
    const { idUsuario } = req.body;
    try{
        const sql = 'SELECT * FROM `users` where id = ?';
        const [rows] = await db.execute(sql, [idUsuario]);
        res.status(200).json({
            success: true,
            user: rows[0]
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: 'Ha ocurrido un problema en el servidor'
        });

    };
})



require('dotenv').config();
const { MercadoPagoConfig, Preference } = require('mercadopago');

// Configura con tu Access Token de prueba
const client = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN // Tu token en el archivo .env
});

app.post("/create_preference", async (req, res) => {
    try {
        const { name, price } = req.body;

        // Validación básica
        if (!name || !price) {
            return res.status(400).json({ error: "Faltan datos: name o price" });
        }

        const body = {
            items: [
                {
                    title: name,
                    quantity: 1,
                    unit_price: Number(price),
                    currency_id: "ARS",
                },
            ],
            back_urls: {
                success: "https://imperio-gym.vercel.app//Success",
                failure: "https://imperio-gym.vercel.app//Failure",
                pending: "https://imperio-gym.vercel.app//Pending",
            },
            auto_return: "approved",
        };

        const preference = new Preference(client);
        const result = await preference.create({ body });

        // Enviamos el init_point para que el front redireccione
        res.json({
            id: result.id,
            init_point: result.init_point
        });

    } catch (error) {
        console.error("ERROR EN MP:", error);
        res.status(500).json({
            error: "Error al crear la preferencia",
            details: error.message
        });
    }
});

app.listen(3001, () => console.log("Servidor corriendo en el puerto 3001"));