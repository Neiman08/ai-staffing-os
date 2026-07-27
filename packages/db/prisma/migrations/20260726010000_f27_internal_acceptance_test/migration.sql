-- F27 (Internal Acceptance Test): registros de prueba interna deben ser
-- distinguibles de datos comerciales reales a nivel de dato, no solo de
-- convención de código. Aditiva -- ningún valor existente se toca.

ALTER TYPE "CompanyOrigin" ADD VALUE 'INTERNAL_TEST';
ALTER TYPE "ContactVerificationStatus" ADD VALUE 'INTERNAL_TEST_VERIFIED';
