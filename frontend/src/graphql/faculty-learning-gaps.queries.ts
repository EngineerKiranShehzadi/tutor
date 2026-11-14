import { gql } from '@apollo/client';
export const GET_FACULTY_LEARNING_GAPS = gql`
 query FacultyLearningGaps($courseId:Int!){
  facultyLearningGaps(courseId:$courseId){
   outcomeId code description mappedQuestions assessedStudents eligibleStudents
   revisionStudents answerAccuracyPercent revisionPercent lectureIds status recommendation
  }
 }
`;
