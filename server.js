const express = require('express')
const cors = require('cors')
const multer = require("multer");
const crypto = require('crypto');
require('dotenv').config();

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

// ⚠️ El webhook de MP necesita el body crudo (raw) para validar la firma.
// Por eso usamos express.raw SOLO para esa ruta, y express.json para el resto.
app.use('/webhook/mercadopago', express.raw({ type: 'application/json' }));
app.use(cors())
app.use(express.json())

const upload = multer({
    storage: multer.memoryStorage()
});

// ─────────────────────────────────────────────
// UTILIDAD: Validar firma del webhook de MP
// Requiere MP_WEBHOOK_SECRET en .env
// ─────────────────────────────────────────────
function validarFirmaMP(req) {
    const secret = process.env.MP_WEBHOOK_SECRET;
    if (!secret) {
        console.warn('[MP webhook] Falta MP_WEBHOOK_SECRET en .env — omitiendo validación de firma');
        return true;
    }

    const signature = req.headers['x-signature'];
    const requestId = req.headers['x-request-id'];

    if (!signature || !requestId) {
        console.warn('[MP webhook] Headers de firma ausentes');
        return false;
    }

    // El header x-signature tiene formato: "ts=...,v1=..."
    const parts = Object.fromEntries(
        signature.split(',').map(part => part.split('='))
    );
    const ts = parts['ts'];
    const v1 = parts['v1'];

    if (!ts || !v1) return false;

    const dataId = req.query['data.id'] || req.query.id || '';
    const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;

    const expected = crypto
        .createHmac('sha256', secret)
        .update(manifest)
        .digest('hex');

    return v1 === expected;
}


// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────
app.get("/", (req, res) => {
    res.send("OK");
});


// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────
app.post('/register', async (req, res) => {
    const { name, pass, email } = req.body;

    try {
        if (!name || !pass || !email) {
            return res.status(400).json({ success: false, message: 'Complete all fields' })
        }
        const sql = "INSERT INTO users (name, password, email) VALUES (?, ?, ?)";
        await db.execute(sql, [name, pass, email]);

        res.status(201).json({
            success: true,
            message: 'Successfully registered user'
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: 'Error registering user'
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
            res.status(401).json({ success: false, message: 'Invalid credentials' })
        }
    } catch (error) {
        console.error(error)
        res.status(500).json({ success: false, message: "Server error" })
    }
})


// ─────────────────────────────────────────────
// RUTINAS
// ─────────────────────────────────────────────
app.get('/rutinas', async (req, res) => {
    try {
        const connection = await db.getConnection();
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
        connection.release();

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
            message: 'Error interno del servidor'
        })
    }
})

app.post('/nuevaRutina', async (req, res) => {
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

        const [resRutina] = await connection.execute(
            'INSERT INTO rutinas (nombre_rutina, nivel, creador) VALUES (?, ?, ?)',
            [nombreRutina, nivel, creador]
        );
        const rutinaId = resRutina.insertId;

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
        await connection.execute(sqlUpdateRutina, [nombreRutina, nivel, creador, rutinaId]);
        await connection.execute('DELETE FROM rutina_detalle WHERE rutina_id = ?', [rutinaId]);

        const sqlInsertEjercicios = 'INSERT INTO rutina_detalle (rutina_id, ejercicio_id, series, repeticiones, orden) VALUES (?, ?, ?, ?, ?)';
        for (const ej of ejercicios) {
            await connection.execute(sqlInsertEjercicios, [rutinaId, ej.ejercicio_id, ej.series, ej.repeticiones, null]);
        }

        await connection.commit();
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
        await db.query("DELETE FROM rutina_detalle WHERE rutina_id = ?", [id]);
        await db.query("DELETE FROM usuario_rutina WHERE rutina_id = ?", [id]);
        await db.query("DELETE FROM rutinas WHERE id = ?", [id]);
        res.status(200).send("Eliminado");
    } catch (error) {
        res.status(500).send(error);
    }
});


// ─────────────────────────────────────────────
// PRODUCTOS
// ─────────────────────────────────────────────
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

    const sql = `INSERT INTO productos (name, price, description, img, size, color) VALUES (?, ?, ?, ?, ?, ?)`;

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

        if (result.length === 0) return res.status(404).send("No encontrado");

        const imagenRaw = result[0].img;
        if (!imagenRaw) return res.status(404).send("Sin imagen");

        const imagen = Buffer.from(imagenRaw.data || imagenRaw);
        res.setHeader("Content-Type", "image/jpeg");
        res.end(imagen);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error");
    }
});

app.delete('/productos/eliminar', async (req, res) => {
    const { id } = req.body;
    try {
        const sql = "DELETE FROM productos WHERE id = ?";
        await db.execute(sql, [id]);
        res.status(200).send("Producto eliminado correctamente");
    } catch (error) {
        console.error(error);
        res.status(500).send("Error al eliminar el producto");
    }
});


// ─────────────────────────────────────────────
// COMPRAS
// ─────────────────────────────────────────────

// NOTA: Esta ruta quedó deshabilitada del flujo de pago.
// Las compras ahora se registran ÚNICAMENTE desde el webhook de MP
// tras verificar que el pago fue aprobado. No llamar desde el frontend.
// Se mantiene solo por si se necesita registrar compras manualmente (admin).
app.post('/guardarCompra', async (req, res) => {
    let { idProducto, idUsuario, fecha } = req.body;

    try {
        const sql = "INSERT INTO `compras`(`idProducto`, `idUsuario`, fechaCompra) VALUES (?, ?, ?)";
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
    try {
        const sql = 'SELECT * FROM compras';
        const [rows] = await db.execute(sql);

        res.status(200).json({
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

app.post('/comprasUsuario', async (req, res) => {
    const { idUsuarioInt } = req.body;
    try {
        const sql = 'SELECT * FROM users WHERE id = ?';
        const [rows] = await db.execute(sql, [idUsuarioInt]);

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Usuario no encontrado'
            });
        }

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

app.post('/productoCompra', async (req, res) => {
    const { idProducto } = req.body;
    const idProd = Number(idProducto);
    try {
        const sql = 'SELECT name, price, description FROM productos WHERE id = ?';
        const [rows] = await db.execute(sql, [idProd]);

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Producto no encontrado'
            });
        }

        res.status(200).json({
            success: true,
            producto: rows[0]
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: 'Ha ocurrido un problema en el servidor'
        });
    }
});


// ─────────────────────────────────────────────
// MERCADO PAGO
// ─────────────────────────────────────────────
const { MercadoPagoConfig, Preference } = require('mercadopago');

const client = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN
});

app.post('/create_preference', async (req, res) => {
    try {
        const { name, price, idProducto, idUsuario } = req.body;
        const parsedPrice = Number(String(price).replace(',', '.'));
        const idProd = Number(idProducto);
        const idUser = Number(idUsuario);

        if (!name || !Number.isFinite(parsedPrice) || parsedPrice <= 0) {
            return res.status(400).json({ error: 'Faltan datos: name o price inválido' });
        }
        if (!Number.isFinite(idProd) || idProd <= 0 || !Number.isFinite(idUser) || idUser <= 0) {
            return res.status(400).json({ error: 'Faltan datos: idProducto o idUsuario' });
        }

        const notificationUrl = process.env.MP_NOTIFICATION_URL;
        if (!notificationUrl) {
            console.warn('[create_preference] Falta MP_NOTIFICATION_URL — el webhook no recibirá notificaciones');
        }

        const body = {
            items: [
                {
                    title: name,
                    quantity: 1,
                    unit_price: parsedPrice,
                    currency_id: 'ARS',
                },
            ],
            // ✅ FIX: metadata como números, no strings
            metadata: {
                id_producto: idProd,
                id_usuario: idUser,
            },
            back_urls: {
                success: 'https://imperio-gym.vercel.app/Success',
                failure: 'https://imperio-gym.vercel.app/Failure',
                pending: 'https://imperio-gym.vercel.app/Pending',
            },
            auto_return: 'approved',
        };

        if (notificationUrl) {
            body.notification_url = notificationUrl;
        }

        const preference = new Preference(client);
        const result = await preference.create({ body });

        res.json({
            id: result.id,
            init_point: result.init_point,
        });
    } catch (error) {
        console.error('ERROR EN MP:', error);
        res.status(500).json({
            error: 'Error al crear la preferencia',
            details: error.message,
        });
    }
});

// ✅ WEBHOOK: MP llama aquí cuando el pago cambia de estado.
// Verificamos la firma, consultamos el pago, y si está aprobado guardamos la compra.
app.post('/webhook/mercadopago', async (req, res) => {
    try {
        // ✅ Validar firma antes de hacer cualquier cosa
        if (!validarFirmaMP(req)) {
            console.warn('[MP webhook] Firma inválida — request rechazado');
            return res.status(401).send('Unauthorized');
        }

        // El body llega como Buffer por express.raw, lo parseamos
        let body;
        try {
            body = JSON.parse(req.body.toString());
        } catch {
            body = {};
        }

        const topic = req.query.topic || body?.type || body?.topic;
        const paymentId =
            req.query.id ||
            req.query['data.id'] ||
            body?.data?.id;

        // Ignorar notificaciones que no son de pago
        if (topic && String(topic) !== 'payment') {
            return res.status(200).send('OK');
        }

        if (!paymentId) {
            console.warn('[MP webhook] Sin id de pago', { query: req.query, body });
            return res.status(200).send('OK');
        }

        const token = process.env.MP_ACCESS_TOKEN;
        if (!token) {
            console.error('[MP webhook] Falta MP_ACCESS_TOKEN');
            return res.status(200).send('OK');
        }

        // Consultamos el estado real del pago directamente a la API de MP
        const payRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });

        if (!payRes.ok) {
            const text = await payRes.text();
            console.error('[MP webhook] Error al consultar pago', payRes.status, text);
            return res.status(200).send('OK');
        }

        const payment = await payRes.json();

        // Solo procesamos pagos aprobados
        if (payment.status !== 'approved') {
            return res.status(200).send('OK');
        }

        const idProducto = Number(payment.metadata?.id_producto);
        const idUsuario = Number(payment.metadata?.id_usuario);

        if (
            !Number.isFinite(idProducto) || idProducto <= 0 ||
            !Number.isFinite(idUsuario) || idUsuario <= 0
        ) {
            console.warn('[MP webhook] Pago aprobado sin metadata válida', payment.metadata);
            return res.status(200).send('OK');
        }

        const [existing] = await db.execute(
            'SELECT id FROM compras WHERE payment_id = ?',
            [String(paymentId)]
        );
        if (existing.length > 0) {
            console.log(`[MP webhook] Compra ya registrada para payment_id ${paymentId}`);
            return res.status(200).json({ ok: true, duplicate: true });
        }

        const fecha = new Date().toISOString().split('T')[0];


        await db.execute(
            'INSERT INTO `compras`(`idProducto`, `idUsuario`, `fechaCompra`, `payment_id`) VALUES (?, ?, ?, ?)',
            [idProducto, idUsuario, fecha, String(paymentId)]
        );

        console.log(`[MP webhook] Compra registrada — producto ${idProducto}, usuario ${idUsuario}`);
        return res.status(200).json({ ok: true });

    } catch (error) {
        console.error('[MP webhook] Error inesperado:', error);
        return res.status(200).send('OK');
    }
});


app.listen(3001, () => console.log("Servidor corriendo en el puerto 3001"));