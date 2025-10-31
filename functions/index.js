// functions/index.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

admin.initializeApp();

// Configure your email service
// Option 1: Gmail (for testing)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: functions.config().email.user, // your-email@gmail.com
        pass: functions.config().email.password // your app password
    }
});

// Option 2: SendGrid (recommended for production)
// const sgMail = require('@sendgrid/mail');
// sgMail.setApiKey(functions.config().sendgrid.key);

// Scheduled function to run on the 1st of every month at 9 AM
exports.sendMonthlyAttendanceReport = functions.pubsub
    .schedule('0 9 1 * *') // Cron expression: minute hour day month dayOfWeek
    .timeZone('Africa/Lagos') // Adjust to your timezone
    .onRun(async (context) => {
        try {
            console.log('Starting monthly attendance report generation...');

            // Get the previous month's date range
            const now = new Date();
            const firstDayLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const lastDayLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

            console.log(`Generating report for: ${firstDayLastMonth.toLocaleDateString()} to ${lastDayLastMonth.toLocaleDateString()}`);

            const db = admin.firestore();

            // Get all events created in the previous month
            const eventsSnapshot = await db.collection('events')
                .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(firstDayLastMonth))
                .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(lastDayLastMonth))
                .get();

            if (eventsSnapshot.empty) {
                console.log('No events found for the previous month');
                return null;
            }

            console.log(`Found ${eventsSnapshot.size} events`);

            // Collect all event IDs
            const eventIds = [];
            const eventNames = {};
            eventsSnapshot.forEach(doc => {
                eventIds.push(doc.id);
                eventNames[doc.id] = doc.data().name;
            });

            // Get all attendance records for these events
            const attendanceSnapshot = await db.collection('attendance')
                .where('eventId', 'in', eventIds)
                .get();

            console.log(`Found ${attendanceSnapshot.size} attendance records`);

            // Build CSV data
            const csvRows = [
                ['Event Name', 'Attendee Name', 'Email', 'Date', 'Time', 'Latitude', 'Longitude', 'Accuracy (m)']
            ];

            attendanceSnapshot.forEach(doc => {
                const data = doc.data();
                const checkedInDate = data.checkedInAt ? new Date(data.checkedInAt) :
                    (data.timestamp?.toDate ? data.timestamp.toDate() : new Date());

                csvRows.push([
                    eventNames[data.eventId] || data.eventId,
                    data.userName || '',
                    data.userEmail || '',
                    checkedInDate.toLocaleDateString('en-GB'), // DD/MM/YYYY
                    checkedInDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), // HH:MM
                    data.location?.lat ?? '',
                    data.location?.lng ?? '',
                    data.location?.accuracy ?? ''
                ]);
            });

            // Convert to CSV string
            const csvContent = csvRows.map(row =>
                row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
            ).join('\n');

            // Format month name for email
            const monthName = firstDayLastMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

            // Get admin email(s) - you can configure this
            const adminEmail = functions.config().email.recipient || 'admin@example.com';

            // Send email with attachment
            const mailOptions = {
                from: functions.config().email.user,
                to: adminEmail,
                subject: `Monthly Attendance Report - ${monthName}`,
                text: `Please find attached the attendance report for ${monthName}.\n\n` +
                    `Summary:\n` +
                    `- Total Events: ${eventsSnapshot.size}\n` +
                    `- Total Attendance Records: ${attendanceSnapshot.size}\n` +
                    `- Report Period: ${firstDayLastMonth.toLocaleDateString()} to ${lastDayLastMonth.toLocaleDateString()}\n\n` +
                    `This is an automated report generated on ${new Date().toLocaleString()}.`,
                attachments: [
                    {
                        filename: `attendance_report_${monthName.replace(' ', '_')}.csv`,
                        content: csvContent,
                        contentType: 'text/csv'
                    }
                ]
            };

            // Send via Nodemailer
            await transporter.sendMail(mailOptions);

            // Alternative: Send via SendGrid
            // const msg = {
            //   to: adminEmail,
            //   from: functions.config().email.user,
            //   subject: `Monthly Attendance Report - ${monthName}`,
            //   text: mailOptions.text,
            //   attachments: [
            //     {
            //       content: Buffer.from(csvContent).toString('base64'),
            //       filename: `attendance_report_${monthName.replace(' ', '_')}.csv`,
            //       type: 'text/csv',
            //       disposition: 'attachment'
            //     }
            //   ]
            // };
            // await sgMail.send(msg);

            console.log(`Email sent successfully to ${adminEmail}`);
            return null;

        } catch (error) {
            console.error('Error generating monthly report:', error);
            throw error;
        }
    });

// Optional: Manual trigger function for testing
exports.sendMonthlyAttendanceReportManual = functions.https.onRequest(async (req, res) => {
    try {
        // Call the same logic as the scheduled function
        await exports.sendMonthlyAttendanceReport.run();
        res.status(200).send('Report generated and sent successfully');
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Error generating report: ' + error.message);
    }
});